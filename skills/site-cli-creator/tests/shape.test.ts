import { describe, expect, test } from "bun:test";
import { describeQuery, graphqlFromBody, graphqlFromSearch, isGraphqlPath, NUMBERS_REDACTED, redactQuery } from "../tools/lib/graphql";
import { bearerClaims, CaptureRecorder, isSignInStep, setCookieNames, shapeFileNames, type RequestInfo } from "../tools/lib/recorder";
import { bodyShape, isIdLike, isValueLikeKey, mergeShapes, redactPath, shapeOf } from "../tools/lib/shape";

// Values that must never show up in anything the Capture produces.
const SECRETS = {
  email: "jens.hansen@example.dk",
  cpr: "010190-1234",
  phone: "+4512345678",
  token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl",
  name: "Jens Hansen",
  street: "Vestergade 12, 2. tv",
  customerId: "C-99812345",
  amount: 349.75,
  uuid: "3f1c2a9e-8b7d-4c6e-9f00-1234567890ab",
  cookie: "SESSION=s3cr3tc00kievalue",
};

function assertNoSecrets(output: string) {
  for (const [kind, value] of Object.entries(SECRETS)) {
    expect(output, `${kind} leaked`).not.toContain(String(value));
  }
  expect(output).not.toContain("349");
  expect(output).not.toContain("99812345");
}

const customer = {
  id: SECRETS.customerId,
  name: SECRETS.name,
  email: SECRETS.email,
  cpr: SECRETS.cpr,
  phones: [SECRETS.phone, null],
  address: { street: SECRETS.street, zip: 8000 },
  balance: SECRETS.amount,
  active: true,
  byEmail: { [SECRETS.email]: { seen: 3 } },
  byId: { "100234": { ok: true }, "100235": { ok: false } },
  products: [
    { id: SECRETS.uuid, price: SECRETS.amount, since: "2020-01-01" },
    { id: "x", price: null, extra: "y" },
  ],
};

describe("shapeOf", () => {
  test("types only, no values", () => {
    const shape = shapeOf(customer);
    assertNoSecrets(JSON.stringify(shape));
    expect(shape).toMatchObject({
      type: "object",
      fields: {
        id: { type: "string" },
        address: { type: "object", fields: { street: { type: "string" }, zip: { type: "number" } } },
        active: { type: "boolean" },
        phones: { type: "array", items: { type: "union", anyOf: [{ type: "string" }, { type: "null" }] } },
      },
    });
  });

  test("arrays merge their elements: nulls make unions, missing keys are optional", () => {
    const shape = shapeOf(customer) as Extract<ReturnType<typeof shapeOf>, { type: "object" }>;
    expect(shape.fields.products).toEqual({
      type: "array",
      items: {
        type: "object",
        fields: {
          id: { type: "string" },
          price: { type: "union", anyOf: [{ type: "number" }, { type: "null" }] },
          since: { type: "string", format: "date" },
          extra: { type: "string" },
        },
        optional: ["extra", "since"],
      },
    });
  });

  test("keys that carry data collapse into a record", () => {
    const shape = shapeOf(customer) as Extract<ReturnType<typeof shapeOf>, { type: "object" }>;
    expect(shape.fields.byEmail).toEqual({ type: "record", values: { type: "object", fields: { seen: { type: "number" } } } });
    expect(shape.fields.byId).toEqual({ type: "record", values: { type: "object", fields: { ok: { type: "boolean" } } } });
  });

  test("strings carry a format class, never a value; it holds only while every observation has it", () => {
    expect(shapeOf({ p: "399.00", d: "2024-01-31", t: "2024-01-31T10:00:00Z", s: SECRETS.name })).toEqual({
      type: "object",
      fields: { p: { type: "string", format: "numeric" }, d: { type: "string", format: "date" }, t: { type: "string", format: "datetime" }, s: { type: "string" } },
    });
    expect(shapeOf(["1", "x"])).toEqual({ type: "array", items: { type: "string" } });
    expect(bodyShape("pin=1234", "application/x-www-form-urlencoded")).toEqual({ kind: "form", shape: { type: "object", fields: { pin: { type: "string" } } } });
  });

  test("dotted keys are data: a map keyed by username collapses into a record", () => {
    expect(isValueLikeKey("jens.hansen")).toBe(true);
    expect(isValueLikeKey("customerId")).toBe(false);
    const shape = shapeOf({ "jens.hansen": { role: "owner" }, "mette.larsen": { role: "admin" } });
    expect(shape).toEqual({ type: "record", values: { type: "object", fields: { role: { type: "string" } } } });
    expect(JSON.stringify(shape)).not.toContain("hansen");
  });

  test("empty arrays have no items; merging fills them", () => {
    expect(shapeOf([])).toEqual({ type: "array" });
    expect(mergeShapes(shapeOf([]), shapeOf(["a"]))).toEqual({ type: "array", items: { type: "string" } });
  });

  test("deeply nested input does not blow the stack", () => {
    let deep: unknown = SECRETS.email;
    for (let i = 0; i < 500; i++) deep = { next: deep };
    assertNoSecrets(JSON.stringify(shapeOf(deep)));
  });
});

describe("redactPath", () => {
  test.each([
    ["/api/customers/12345/orders", "/api/customers/:id/orders"],
    [`/api/products/${SECRETS.uuid}`, "/api/products/:id"],
    [`/api/users/${encodeURIComponent(SECRETS.email)}/settings`, "/api/users/:id/settings"],
    [`/api/cpr/${SECRETS.cpr}`, "/api/cpr/:id"],
    ["/api/orders/9f86d081884c7d659a2feaa0c55ad015", "/api/orders/:id"],
    [`/t/${SECRETS.token}`, "/t/:id"],
    ["/api/v2/invoices", "/api/v2/invoices"],
    ["/graphql", "/graphql"],
    ["/shop/api/session-management/post-login", "/shop/api/session-management/post-login"],
    ["/search/Jens%20Hansen", "/search/:id"],
    ["/api/users/andreas.johansen/profile", "/api/users/:id/profile"],
    ["/api/users/jens.hansen/invoices", "/api/users/:id/invoices"],
    ["/static/app.js", "/static/app.js"],
    ["/.well-known/openid-configuration", "/.well-known/openid-configuration"],
    // A per-session random segment that appears nowhere else in the traffic (#87): PingFederate's resume path.
    ["/as/aB3dE5fGh1/resume/as/authorization.ping", "/as/:id/resume/as/:id"],
    ["/as/QxAbKfPzRt/resume/as/authorization.ping", "/as/:id/resume/as/:id"],
    ["/flow/k3q9zx7mw2/next", "/flow/:id/next"],
    ["/", "/"],
  ])("%s → %s", (input, expected) => {
    expect(redactPath(input)).toBe(expected);
  });

  test("names stay names", () => {
    for (const seg of ["ecare", "oauth2", "v1", "listFtpdProducts", "post-login", "i18n"]) expect(isIdLike(seg)).toBe(false);
    // camelCase names with acronyms and digits are not random (#87).
    for (const seg of ["eSIMsForUser", "oauth2Login", "XMLHttpRequest", "getMSISDNList", "iOSDevices", "s3Bucket", "myYouSee", "openIdConnect", "PaymentMethods", "base64Encoded", "ipv4Address", "x509Certs", "authorization", "subscriptions"]) {
      expect({ seg, idLike: isIdLike(seg) }).toEqual({ seg, idLike: false });
    }
  });
});

describe("bodyShape", () => {
  test("JSON, form, text, binary, multipart, empty", () => {
    const json = bodyShape(Buffer.from(JSON.stringify(customer)), "application/json; charset=utf-8");
    expect(json.kind).toBe("json");
    assertNoSecrets(JSON.stringify(json));
    const form = bodyShape(`email=${encodeURIComponent(SECRETS.email)}&password=hunter2`, "application/x-www-form-urlencoded");
    expect(form).toEqual({
      kind: "form",
      shape: { type: "object", fields: { email: { type: "string" }, password: { type: "string" } } },
    });
    expect(bodyShape(`<p>${SECRETS.name}</p>`, "text/html")).toEqual({ kind: "html" });
    expect(bodyShape(SECRETS.email, "text/plain")).toEqual({ kind: "text" });
    expect(bodyShape(Buffer.from([0, 1, 2, 3]), "application/octet-stream")).toEqual({ kind: "binary" });
    expect(bodyShape("--x\r\n", "multipart/form-data; boundary=x")).toEqual({ kind: "multipart" });
    expect(bodyShape(null, "application/json")).toEqual({ kind: "empty" });
  });
});

describe("GraphQL", () => {
  test("query text is kept, literals and comments are not", () => {
    const q = `# fetched for ${SECRETS.name}
query getCustomer($id: ID!, $id2: ID) {
  getCustomer(id: $id, hint: "${SECRETS.email}", n: 99812345, zip: 2100, ref: 1234, amount: 349.75, first: 10) { id name }
}`;
    const red = redactQuery(q);
    assertNoSecrets(red);
    expect(red).toContain("query getCustomer($id: ID!, $id2: ID)");
    // Every number literal is a value: a 4-digit customer id or postcode included.
    for (const v of ["2100", "1234", "349", "10"]) expect(red).not.toContain(v);
    expect(red).toContain("zip: 0, ref: 0, amount: 0, first: 0");
    expect(red.split("\n")[0]).toBe(NUMBERS_REDACTED);
    expect(redactQuery("query q { a(first: 0) }")).toBe("query q { a(first: 0) }");
  });

  test("operation type and name", () => {
    expect(describeQuery("mutation createQuote($i: In!) { createQuote(input: $i) { id } }")).toEqual({
      type: "mutation",
      name: "createQuote",
    });
    expect(describeQuery("{ me { query } }")).toEqual({ type: "query", name: null });
    expect(describeQuery("query A { a } mutation B { b }", "B")).toEqual({ type: "mutation", name: "B" });
    expect(describeQuery('query A { search(query: "mutation X") { query } }')).toEqual({ type: "query", name: "A" });
  });

  test("bodies: single, batch, persisted, GET", () => {
    const single = graphqlFromBody({ operationName: "getCustomer", query: "query getCustomer { x }", variables: { id: SECRETS.customerId } });
    expect(single?.[0]).toMatchObject({ operationName: "getCustomer", operationType: "query", variables: { type: "object", fields: { id: { type: "string" } } } });
    assertNoSecrets(JSON.stringify(single));
    expect(graphqlFromBody([{ query: "mutation m { m }" }, { query: "query q { q }" }])?.map((c) => c.operationName)).toEqual(["m", "q"]);
    expect(graphqlFromBody({ operationName: "p", extensions: { persistedQuery: { sha256Hash: "ab" } } })?.[0]).toMatchObject({ persisted: true, query: null });
    expect(graphqlFromBody({ hello: "world" })).toBeNull();
    const get = graphqlFromSearch(new URLSearchParams({ query: "query q { q }", variables: JSON.stringify({ e: SECRETS.email }) }));
    expect(get?.[0]?.operationName).toBe("q");
    assertNoSecrets(JSON.stringify(get));
  });

  test("GraphQL only on a GraphQL path or with a GraphQL document: a REST `query` parameter is not (#33)", () => {
    // A search word in `?query=` is a value, not a document.
    expect(graphqlFromSearch(new URLSearchParams({ query: "Fjordkaffe", limit: "25" }))).toBeNull();
    expect(graphqlFromSearch(new URLSearchParams({ query: "query" }))).toBeNull();
    expect(graphqlFromBody({ query: "Fjordkaffe", limit: 25 })).toBeNull();
    expect(graphqlFromSearch(new URLSearchParams({ query: "{ me { id } }" }))?.[0]).toMatchObject({ operationType: "query" });
    expect(graphqlFromBody({ query: "query Search($q: String) { search(q: $q) { id } }" })?.[0]?.operationName).toBe("Search");
    expect(graphqlFromBody({ query: "fragment F on X { id } query Q { x { ...F } }" })?.[0]?.operationName).toBe("Q");
    expect(graphqlFromBody({ extensions: { persistedQuery: { sha256Hash: "ab" } } })?.[0]).toMatchObject({ persisted: true });
    // On a GraphQL path, `query` is the document whatever it looks like.
    expect(graphqlFromSearch(new URLSearchParams({ query: "me" }), { graphqlPath: true })).not.toBeNull();
    expect(isGraphqlPath("/graphql")).toBe(true);
    expect(isGraphqlPath("/api/graphql/v2")).toBe(true);
    expect(isGraphqlPath("/gql")).toBe(true);
    expect(isGraphqlPath("/api/search/suppliers")).toBe(false);
  });
});

function req(partial: Partial<RequestInfo> & { url: string }): RequestInfo {
  return { method: "GET", headers: {}, postData: null, resourceType: "fetch", ...partial };
}

const json = (v: unknown) => Buffer.from(JSON.stringify(v));

describe("CaptureRecorder", () => {
  const origin = "https://www.shop.example";

  test("scope: origin, parent domain, subdomains and login hosts only", () => {
    const r = new CaptureRecorder({ origin, loginHosts: ["login.idp.example"] });
    expect(r.inScope("https://www.shop.example/a")).toBe(true);
    expect(r.inScope("https://api.shop.example/a")).toBe(true);
    expect(r.inScope("https://shop.example/a")).toBe(true);
    expect(r.inScope("https://login.idp.example/authorize")).toBe(true);
    expect(r.inScope("https://evilshop.example/a")).toBe(false);
    expect(r.inScope("https://www.google-analytics.com/collect")).toBe(false);
    expect(r.inScope("data:text/plain,hi")).toBe(false);
  });

  test("a REST GET with ?query=<word> is one REST Operation whose query shape lists `query` as a type (#33)", () => {
    const r = new CaptureRecorder({ origin });
    const plan = r.plan(req({ url: `${origin}/api/search/suppliers?query=Fjordkaffe&limit=25&sortBy=BestMatch` }))!;
    r.record(plan, { response: { status: 200, headers: { "content-type": "application/json" }, body: json({ items: [] }) } });
    const ops = r.operations();
    expect(ops.map((o) => [o.kind, o.operation])).toEqual([["rest", "GET /api/search/suppliers"]]);
    expect(ops[0]!.request.query).toEqual({ type: "object", fields: { query: { type: "string" }, limit: { type: "string" }, sortBy: { type: "string" } } });
    expect(JSON.stringify(ops)).not.toContain("Fjordkaffe");
    const post = r.plan(req({ url: `${origin}/api/search`, method: "POST", postData: json({ query: "Fjordkaffe" }), headers: { "content-type": "application/json" } }))!;
    expect(post.calls[0]!.shape.kind).toBe("rest");
    const gql = r.plan(req({ url: `${origin}/graphql?query=${encodeURIComponent("{ me { id } }")}` }))!;
    expect(gql.calls[0]!.shape.kind).toBe("graphql");
  });

  test("Next.js: a server action is flagged serverAction + effectUnknown; RSC streams are marked rsc (#36)", () => {
    const r = new CaptureRecorder({ origin });
    const action = r.plan(
      req({
        url: `${origin}/partner/4711`,
        method: "POST",
        headers: { "next-action": "7f3a9c", accept: "text/x-component", "content-type": "text/plain;charset=UTF-8" },
        postData: Buffer.from('["4711"]'),
      }),
    )!;
    expect(action.calls[0]!.shape).toMatchObject({ effect: "write", effectUnknown: true, serverAction: true });
    expect(action.serverAction).toBe(true);
    expect(r.shouldAbort(action)).toBe(true);
    r.record(action, { aborted: true });
    const rsc = r.plan(req({ url: `${origin}/partner/4711?_rsc=1x2y3`, headers: { rsc: "1" } }))!;
    expect(rsc.calls[0]!.shape.rsc).toBe(true);
    const plain = r.plan(req({ url: `${origin}/api/partners` }))!;
    r.record(plain, { response: { status: 200, headers: { "content-type": "text/x-component" }, body: Buffer.from("0:[]") } });
    const ops = r.operations();
    expect(ops.find((o) => o.operation === "GET /api/partners")?.rsc).toBe(true);
    expect(ops.find((o) => o.operation.startsWith("POST"))).toMatchObject({ serverAction: true, effectUnknown: true });
  });

  test("static assets are skipped, fetches recorded", () => {
    const r = new CaptureRecorder({ origin });
    expect(r.plan(req({ url: `${origin}/app.js`, resourceType: "script" }))).toBeNull();
    expect(r.plan(req({ url: `${origin}/api/me` }))).not.toBeNull();
  });

  test("read Task aborts writes; --write lets exactly the first through; login hosts are never blocked", () => {
    const read = new CaptureRecorder({ origin, loginHosts: ["login.idp.example"] });
    const post = () => req({ url: `${origin}/api/notes`, method: "POST", postData: json({ text: "x" }), headers: { "content-type": "application/json" } });
    expect(read.shouldAbort(read.plan(post())!)).toBe(true);
    expect(read.shouldAbort(read.plan(req({ url: `${origin}/api/me` }))!)).toBe(false);
    const gqlRead = req({ url: `${origin}/graphql`, method: "POST", postData: json({ query: "query q { q }" }) });
    expect(read.shouldAbort(read.plan(gqlRead)!)).toBe(false);
    const gqlWrite = req({ url: `${origin}/graphql`, method: "POST", postData: json({ query: "mutation m { m }" }) });
    expect(read.shouldAbort(read.plan(gqlWrite)!)).toBe(true);
    const login = req({ url: "https://login.idp.example/token", method: "POST", postData: Buffer.from("a=b") });
    expect(read.shouldAbort(read.plan(login)!)).toBe(false);

    const write = new CaptureRecorder({ origin, allowWrite: true });
    write.noteGesture();
    expect(write.shouldAbort(write.plan(post())!)).toBe(false);
    expect(write.shouldAbort(write.plan(post())!)).toBe(true);
  });

  test("sign-in steps are recognised by path, operation name or host", () => {
    for (const yes of ["/oauth/token", "/shop/api/session-management/post-login", "/api/session/post-login", "/u/login", "/sign-in", "signIn", "loginUser", "/connect/authorize", "/saml2/acs"]) {
      expect(isSignInStep("POST", yes), yes).toBe(true);
    }
    for (const no of ["/api/notes", "/api/authors", "/assortment", "addNote", "/api/quotes", "createQuote", "/api/tokenized-cards-x", "/api/payment-tokens", "revokeApiToken", "/api/user/session-preferences", "/api/password", "logoutUser", "/api/auth/logout"]) {
      expect(isSignInStep("POST", no), no).toBe(false);
    }
    for (const yes of ["/connect/token", "/api/token", "/token/refresh", "/api/session", "refreshToken", "tokenAuth", "createSession"]) {
      expect(isSignInStep("POST", yes), yes).toBe(true);
    }
    expect(isSignInStep("DELETE", "/api/sessions")).toBe(false);
    expect(isSignInStep("DELETE", "/oauth/token")).toBe(false);
    const r = new CaptureRecorder({ origin });
    const post = (url: string, body: unknown = {}) => req({ url, method: "POST", postData: json(body) });
    const token = r.plan(post(`${origin}/oauth/token`))!;
    expect(token.loginFlow).toBe(true);
    expect(token.calls[0]!.shape.loginFlow).toBe(true);
    expect(r.shouldAbort(token)).toBe(false);
    // A host that only looks like a sign-in host: its sign-in form (a document POST) goes through, its API writes do not.
    const form = (url: string) => req({ url, method: "POST", postData: Buffer.from("a=b"), resourceType: "document", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(r.shouldAbort(r.plan(form("https://login.shop.example/u/password"))!)).toBe(false);
    expect(r.shouldAbort(r.plan(form("https://id.shop.example/x"))!)).toBe(false);
    expect(r.shouldAbort(r.plan(post("https://id.shop.example/x"))!)).toBe(true);
    expect(r.shouldAbort(r.plan(post(`${origin}/graphql`, { query: "mutation signInUser { signInUser { ok } }" }))!)).toBe(false);
    expect(r.shouldAbort(r.plan(post(`${origin}/graphql`, [{ query: "mutation signIn { a }" }, { query: "mutation addNote { b }" }]))!)).toBe(true);
    const quote = r.plan(post(`${origin}/api/quotes`))!;
    expect(quote.loginFlow).toBe(false);
    expect(quote.calls[0]!.shape.loginFlow).toBeUndefined();
    expect(r.shouldAbort(quote)).toBe(true);
    expect(r.plan(req({ url: `${origin}/api/session` }))!.loginFlow).toBe(false); // reads need no exemption

    const write = new CaptureRecorder({ origin, allowWrite: true });
    write.noteGesture();
    expect(write.shouldAbort(write.plan(post(`${origin}/oauth/token`))!)).toBe(false);
    expect(write.shouldAbort(write.plan(post(`${origin}/api/notes`))!)).toBe(false); // the sign-in did not use up the one write
    expect(write.shouldAbort(write.plan(post(`${origin}/api/notes`))!)).toBe(true);
  });

  test("recorded operations carry shapes only", () => {
    const r = new CaptureRecorder({ origin });
    const gql = r.plan(
      req({
        url: `${origin}/graphql`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${SECRETS.token}`,
          cookie: SECRETS.cookie,
          "x-apollo-operation-name": "getCustomer",
        },
        postData: json({ operationName: "getCustomer", query: `query getCustomer($id: ID!) { getCustomer(id: $id) { id email } }`, variables: { id: SECRETS.customerId, email: SECRETS.email } }),
      }),
    )!;
    r.record(gql, {
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRETS.token}`, cookie: SECRETS.cookie },
      response: { status: 200, headers: { "content-type": "application/json", "set-cookie": SECRETS.cookie }, body: json({ data: { getCustomer: customer } }) },
    });
    const rest = r.plan(req({ url: `${origin}/api/customers/${SECRETS.customerId}/invoices?email=${encodeURIComponent(SECRETS.email)}&page=2`, headers: { accept: "application/json" } }))!;
    r.record(rest, { response: { status: 200, headers: { "content-type": "application/json" }, body: json({ invoices: [{ amount: SECRETS.amount, cpr: SECRETS.cpr }] }) } });
    const rest2 = r.plan(req({ url: `${origin}/api/customers/C-11112222/invoices` }))!;
    r.record(rest2, { response: { status: 404, headers: {}, body: null } });
    const write = r.plan(req({ url: `${origin}/api/notes`, method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, postData: json({ text: SECRETS.street }) }))!;
    r.record(write, { aborted: true, headers: { "content-type": "application/json; charset=utf-8" } });

    const ops = r.operations();
    assertNoSecrets(JSON.stringify(ops));
    expect(ops.map((o) => [o.operation, o.effect])).toEqual([
      ["getCustomer", "read"],
      ["GET /api/customers/:id/invoices", "read"],
      ["POST /api/notes", "write"],
    ]);
    const [g, inv, note] = ops;
    expect(g!.graphql?.query).toContain("getCustomer(id: $id) { id email }");
    expect(g!.request.headers).toEqual({ authorization: null, "content-type": "application/json", cookie: null });
    expect(g!.request.variables).toEqual({ type: "object", fields: { id: { type: "string" }, email: { type: "string" } } });
    expect(inv!.seen).toBe(2);
    expect(inv!.responses.map((x) => x.status)).toEqual([200, 404]);
    expect(inv!.request.query).toEqual({ type: "object", fields: { email: { type: "string" }, page: { type: "string" } } });
    expect(note!.aborted).toBe(1);
    expect(note!.responses).toEqual([]);
    expect(note!.request.body).toEqual({ kind: "json", shape: { type: "object", fields: { text: { type: "string" } } } });
    expect(shapeFileNames(ops, "www.shop.example")).toEqual([
      "getCustomer.shape.json",
      "GET-api-customers-id-invoices.shape.json",
      "POST-api-notes.shape.json",
    ]);
  });

  test("batched GraphQL splits the response per operation", () => {
    const r = new CaptureRecorder({ origin });
    const plan = r.plan(req({ url: `${origin}/graphql`, method: "POST", postData: json([{ query: "query a { a }" }, { query: "query b { b }" }]) }))!;
    r.record(plan, { response: { status: 200, headers: { "content-type": "application/json" }, body: json([{ data: { a: 1 } }, { data: { b: "x" } }]) } });
    const [a, b] = r.operations();
    expect(a!.responses[0]!.body).toEqual({ kind: "json", shape: { type: "object", fields: { data: { type: "object", fields: { a: { type: "number" } } } } } });
    expect(b!.responses[0]!.body).toEqual({ kind: "json", shape: { type: "object", fields: { data: { type: "object", fields: { b: { type: "string" } } } } } });
  });

  test("file names stay unique and path-safe", () => {
    const r = new CaptureRecorder({ origin });
    for (const url of [`${origin}/`, `https://api.shop.example/`, `${origin}/a/b`]) r.record(r.plan(req({ url }))!, {});
    expect(shapeFileNames(r.operations(), "www.shop.example")).toEqual([
      "GET-root.shape.json",
      "api.shop.example-GET-root.shape.json",
      "GET-a-b.shape.json",
    ]);
  });
});

// Review findings: a Capture must never write for real outside the Task's one write, and must
// never keep a value, wherever it shows up.
describe("Capture safety", () => {
  const origin = "https://www.example.com";
  const post = (url: string, body: unknown = {}, extra: Partial<RequestInfo> = {}) =>
    req({ url, method: "POST", postData: json(body), headers: { "content-type": "application/json" }, ...extra });

  test("a persisted (hash-only) GraphQL POST is treated as a write: aborted in a read Task unless --allow-read names it", () => {
    const apq = (name: string) => post(`${origin}/graphql`, { operationName: name, extensions: { persistedQuery: { version: 1, sha256Hash: "abc" } } });
    const read = new CaptureRecorder({ origin });
    const cancel = read.plan(apq("cancelSubscription"))!;
    expect(cancel.effect).toBe("write");
    expect(cancel.calls[0]!.shape).toMatchObject({ effect: "write", effectUnknown: true });
    expect(read.shouldAbort(cancel)).toBe(true);
    // A persisted query over GET is a query (servers refuse mutations over GET).
    const get = read.plan(req({ url: `${origin}/graphql?operationName=getX&extensions=${encodeURIComponent(JSON.stringify({ persistedQuery: { sha256Hash: "a" } }))}` }))!;
    expect(get.effect).toBe("read");
    // Declared reads go through and are marked.
    const allowed = new CaptureRecorder({ origin, allowRead: ["getSubscription"] });
    const plan = allowed.plan(apq("getSubscription"))!;
    expect(allowed.shouldAbort(plan)).toBe(false);
    expect(plan.calls[0]!.shape.allowedRead).toBe(true);
    expect(allowed.shouldAbort(allowed.plan(apq("cancelSubscription"))!)).toBe(true);
  });

  test("ordinary writes that only mention a sign-in word are aborted in a read Task", () => {
    const r = new CaptureRecorder({ origin, loginHosts: ["login.example.com"] });
    const cases: RequestInfo[] = [
      req({ url: `${origin}/api/sessions/all`, method: "DELETE" }),
      post(`${origin}/api/payment-tokens`),
      post(`${origin}/graphql`, { operationName: "revokeApiToken", query: "mutation revokeApiToken { revokeApiToken { ok } }" }),
      post("https://auth.example.com/api/password"),
      req({ url: `${origin}/api/user/session-preferences`, method: "PUT", postData: json({}) }),
      req({ url: "https://login.example.com/api/sessions/1", method: "DELETE" }),
      post("https://login.example.com/api/logout"),
    ];
    for (const c of cases) {
      const plan = r.plan(c)!;
      expect({ c: `${c.method} ${c.url}`, abort: r.shouldAbort(plan), loginFlow: plan.loginFlow }).toEqual({ c: `${c.method} ${c.url}`, abort: true, loginFlow: false });
    }
    // A declared login host's sign-in form still goes through.
    expect(r.shouldAbort(r.plan(post("https://login.example.com/u/login/password", {}, { resourceType: "document" }))!)).toBe(false);
  });

  test("--write: a write the page fires while loading is aborted; the user's write after a click goes through", () => {
    const r = new CaptureRecorder({ origin, allowWrite: true });
    const quote = post(`${origin}/graphql`, { operationName: "createQuote", query: "mutation createQuote { createQuote { id } }" });
    expect(r.shouldAbort(r.plan(quote)!)).toBe(true); // page load, no gesture yet
    r.noteGesture();
    expect(r.shouldAbort(r.plan(post(`${origin}/api/settings`))!)).toBe(false);
    expect(r.wrote).toBe("POST /api/settings");
    expect(r.shouldAbort(r.plan(quote)!)).toBe(true); // one write only
    // A new page starts over.
    const again = new CaptureRecorder({ origin, allowWrite: true });
    again.noteGesture();
    again.noteNavigation();
    expect(again.shouldAbort(again.plan(quote)!)).toBe(true);
  });

  test("--write-op names the write that may go through, gesture or not", () => {
    const r = new CaptureRecorder({ origin, allowWrite: true, writeOp: "POST /api/settings" });
    r.noteGesture();
    expect(r.shouldAbort(r.plan(post(`${origin}/graphql`, { operationName: "createQuote", query: "mutation createQuote { a }" }))!)).toBe(true);
    expect(r.shouldAbort(r.plan(post(`${origin}/api/settings`))!)).toBe(false);
    expect(r.wrote).toBe("POST /api/settings");
    const gql = new CaptureRecorder({ origin, allowWrite: true, writeOp: "addNote" });
    expect(gql.shouldAbort(gql.plan(post(`${origin}/graphql`, { operationName: "addNote", query: "mutation addNote { a }" }))!)).toBe(false);
  });

  test("writes outside the recorded scope are aborted too, except sign-in steps and --allow-read", () => {
    const r = new CaptureRecorder({ origin: "https://api.shop-backend.net", allowRead: ["search.example.net/1/indexes"] });
    const cart = { method: "POST", url: "https://www.shop.dk/api/cart", resourceType: "fetch" };
    expect(r.plan({ ...cart, headers: {}, postData: null })).toBeNull();
    expect(r.allowElsewhere(cart)).toBe(false);
    expect([...r.blockedElsewhere]).toEqual(["POST www.shop.dk/api/cart"]);
    expect(r.allowElsewhere({ method: "GET", url: "https://www.shop.dk/", resourceType: "document" })).toBe(true);
    expect(r.allowElsewhere({ method: "POST", url: "https://login.microsoftonline.com/common/oauth2/v2.0/token", resourceType: "fetch" })).toBe(true);
    expect(r.allowElsewhere({ method: "POST", url: "https://login.microsoftonline.com/common/login", resourceType: "document" })).toBe(true);
    expect(r.allowElsewhere({ method: "POST", url: "https://search.example.net/1/indexes/x/queries", resourceType: "fetch" })).toBe(true);
    expect(r.allowElsewhere({ method: "POST", url: "https://www.google-analytics.com/g/collect", resourceType: "ping" })).toBe(false);
    expect(r.allowElsewhere({ method: "POST", url: "data:text/plain,x", resourceType: "fetch" })).toBe(true);
  });

  test("an OAuth token request (a POST whose body has grant_type) is a sign-in step on any host (#85)", () => {
    const form = (url: string, extra: Partial<RequestInfo> = {}) =>
      req({
        url,
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        postData: Buffer.from("grant_type=authorization_code&code=c0de1234&code_verifier=v3r1f13r&client_id=web&redirect_uri=https%3A%2F%2Fwww.example.com%2Fcb"),
        ...extra,
      });
    // login.<site> is in scope but not declared: the token exchange is a fetch to a path no sign-in word names.
    const r = new CaptureRecorder({ origin });
    const exchange = r.plan(form("https://login.example.com/as/token.oauth2"))!;
    expect({ loginFlow: exchange.loginFlow, abort: r.shouldAbort(exchange) }).toEqual({ loginFlow: true, abort: false });
    expect([...r.signInHosts]).toEqual(["login.example.com"]);
    // A JSON refresh on the site's own API, and a token request on a host outside the Capture.
    const refresh = r.plan(post(`${origin}/api/oauth/v2`, { grant_type: "refresh_token", refresh_token: SECRETS.token }))!;
    expect(r.shouldAbort(refresh)).toBe(false);
    expect(r.allowElsewhere(form("https://idp.partner.net/as/token.oauth2"))).toBe(true);
    // Not a token request: no grant_type, or a grant_type that is only a word in the path.
    expect(r.shouldAbort(r.plan(post(`${origin}/api/grants`, { type: "account" }))!)).toBe(true);
    expect(r.shouldAbort(r.plan(post(`${origin}/api/grant_type`, {}))!)).toBe(true);
    expect(r.allowElsewhere(req({ url: "https://idp.partner.net/oauth/revoke", method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, postData: Buffer.from("token=abc") }))).toBe(false);
  });

  test("well-known eID and sign-in providers are login hosts without --login-host (#85)", () => {
    const r = new CaptureRecorder({ origin });
    for (const url of ["https://signicat-id.mitid.dk/std/method/acme/x1/api/initAuth", "https://acme.criipto.id/oauth2/authorize", "https://acme.eu.auth0.com/u/login", "https://acme.okta.com/api/v1/authn"]) {
      expect(r.inScope(url), url).toBe(true);
      const plan = r.plan(post(url))!;
      expect({ url, loginFlow: plan.loginFlow, abort: r.shouldAbort(plan) }).toEqual({ url, loginFlow: true, abort: false });
    }
    expect([...r.signInHosts].sort()).toEqual(["acme.criipto.id", "acme.eu.auth0.com", "acme.okta.com", "signicat-id.mitid.dk"]);
    // Only those domains: a look-alike is not one.
    expect(r.inScope("https://mitid.dk.example.net/api/initAuth")).toBe(false);
    expect(r.inScope("https://notmitid.dk/api/initAuth")).toBe(false);
    // Even there, a change to the account is no sign-in step.
    expect(r.shouldAbort(r.plan(post("https://acme.okta.com/api/v1/users/me/logout"))!)).toBe(true);
  });

  test("a write aborted on a host this tab navigated to names --login-host at once (#85)", () => {
    const r = new CaptureRecorder({ origin });
    r.notePageHost("https://idp.partner.net/start");
    r.notePageHost(`${origin}/home`);
    expect(r.signInSuspect("https://idp.partner.net/api/begin")).toBe("idp.partner.net");
    expect(r.signInSuspect("https://login.example.com/api/begin")).toBe("login.example.com"); // named like a sign-in host
    expect(r.signInSuspect(`${origin}/api/notes`)).toBeUndefined(); // the site's own host
    expect(r.signInSuspect("https://www.google-analytics.com/g/collect")).toBeUndefined();
    // The site's own subdomains: a page loaded there is just the site, so only a sign-in name makes one a suspect
    // (an explore walk submits forms on purpose, and every such write is aborted).
    r.notePageHost("https://shop.example.com/cart");
    expect(r.signInSuspect("https://shop.example.com/api/cart")).toBeUndefined();
    expect(r.signInSuspect("https://example.com/api/collect")).toBeUndefined();
    const declared = new CaptureRecorder({ origin, loginHosts: ["idp.partner.net"] });
    declared.notePageHost("https://idp.partner.net/start");
    expect(declared.signInSuspect("https://idp.partner.net/api/begin")).toBeUndefined();
  });

  test("a path segment that is a value the page sent or received becomes :id", () => {
    const r = new CaptureRecorder({ origin });
    const get = (path: string, body: unknown) => {
      const plan = r.plan(req({ url: `${origin}${path}` }))!;
      r.record(plan, { response: { status: 200, headers: { "content-type": "application/json" }, body: json(body) } });
    };
    get("/u/mette-larsen/orders", { username: "mette-larsen", orders: [] });
    get("/search/Vesterbrogade", { hits: [{ address: "Vesterbrogade 1, 1620 København V" }] });
    get("/api/subscriptions/active", { subscriptions: [{ state: "Active" }] });
    get("/api/invoices", { invoices: [{ status: "paid" }] });
    const ops = r.operations();
    expect(ops.map((o) => o.operation)).toEqual(["GET /u/:id/orders", "GET /search/:id", "GET /api/subscriptions/active", "GET /api/invoices"]);
    const all = JSON.stringify(ops);
    for (const leak of ["mette", "Vesterbrogade"]) expect(all).not.toContain(leak);
    expect(r.redactValues("/search/Vesterbrogade")).toBe("/search/:id");
  });

  test("bearer claim names, response header names and Set-Cookie names are recorded, never their values", () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = `${b64({ alg: "HS256" })}.${b64({ sub: "99812345", account_ref: SECRETS.customerId, email: SECRETS.email, exp: 1700000000 })}.c2ln`;
    expect(bearerClaims(`Bearer ${jwt}`)).toEqual({
      type: "object",
      fields: { sub: { type: "string", format: "numeric" }, account_ref: { type: "string" }, email: { type: "string" }, exp: { type: "number" } },
    });
    expect(bearerClaims("Bearer opaque-token")).toBeUndefined();
    // Claim names are schema, never collapsed into a record (#86): dotted and namespaced names stay; a claim
    // name that is itself a value (an email) becomes :id. Nested objects keyed by data still collapse.
    const idp = `${b64({ alg: "RS256" })}.${b64({
      iss: "https://login.example.dk",
      sub: SECRETS.uuid,
      "pi.sri": "x7Yq",
      "https://example.dk/claims/roles": ["user"],
      ciam_id: SECRETS.customerId,
      individualId: "99812345",
      authorization_details: [{ type: "account", locations: ["x"] }],
      households: { [SECRETS.uuid]: "owner" },
      [SECRETS.email]: true,
    })}.c2ln`;
    const claims = bearerClaims(`Bearer ${idp}`) as { type: string; fields: Record<string, { type: string }> };
    expect(claims.type).toBe("object");
    expect(Object.keys(claims.fields)).toEqual(["iss", "sub", "pi.sri", "https://example.dk/claims/roles", "ciam_id", "individualId", "authorization_details", "households", ":id"]);
    expect(claims.fields.households!.type).toBe("record");
    expect(claims.fields[":id"]).toEqual({ type: "boolean" });
    assertNoSecrets(JSON.stringify(claims));
    expect(setCookieNames(`csrf_token=${SECRETS.cookie}; Path=/\nsid=x; HttpOnly`)).toEqual(["csrf_token", "sid"]);

    const r = new CaptureRecorder({ origin });
    const plan = r.plan(req({ url: `${origin}/`, resourceType: "document", headers: { authorization: `Bearer ${jwt}` } }))!;
    r.record(plan, {
      headers: { authorization: `Bearer ${jwt}` },
      response: { status: 200, headers: { "content-type": "text/html; charset=utf-8", "set-cookie": `csrf_token=${SECRETS.cookie}; Path=/`, "x-request-id": SECRETS.uuid }, body: Buffer.from("<html></html>") },
    });
    const [op] = r.operations();
    expect(op!.navigation).toBe(true);
    expect(Object.keys((op!.request.bearerClaims as { fields: object }).fields)).toEqual(["sub", "account_ref", "email", "exp"]);
    expect(op!.responses[0]).toEqual({
      status: 200,
      contentType: "text/html",
      headers: { "content-type": "text/html", "x-request-id": null },
      setCookies: ["csrf_token"],
      body: { kind: "html" },
    });
    assertNoSecrets(JSON.stringify(op));
    expect(JSON.stringify(op)).not.toContain(jwt);
  });

  test("requests to a declared login host are sign-in steps, reads included", () => {
    const r = new CaptureRecorder({ origin, loginHosts: ["login.example.com"] });
    expect(r.plan(req({ url: "https://login.example.com/u/login", resourceType: "document" }))!.calls[0]!.shape.loginFlow).toBe(true);
    expect(r.plan(req({ url: `${origin}/account`, resourceType: "document" }))!.calls[0]!.shape.loginFlow).toBeUndefined();
  });
});
