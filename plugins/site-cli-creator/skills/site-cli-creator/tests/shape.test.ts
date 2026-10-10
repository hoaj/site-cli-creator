import { describe, expect, test } from "bun:test";
import { describeQuery, graphqlFromBody, graphqlFromSearch, redactQuery } from "../tools/lib/graphql";
import { CaptureRecorder, isLoginFlow, shapeFileNames, type RequestInfo } from "../tools/lib/recorder";
import { bodyShape, isIdLike, mergeShapes, redactPath, shapeOf } from "../tools/lib/shape";

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
          since: { type: "string" },
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
    ["/", "/"],
  ])("%s → %s", (input, expected) => {
    expect(redactPath(input)).toBe(expected);
  });

  test("names stay names", () => {
    for (const seg of ["ecare", "oauth2", "v1", "listFtpdProducts", "post-login", "i18n"]) expect(isIdLike(seg)).toBe(false);
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
query getCustomer($id: ID!) {
  getCustomer(id: $id, hint: "${SECRETS.email}", n: 99812345, first: 10) { id name }
}`;
    const red = redactQuery(q);
    assertNoSecrets(red);
    expect(red).toContain("query getCustomer($id: ID!)");
    expect(red).toContain("first: 10");
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
    expect(write.shouldAbort(write.plan(post())!)).toBe(false);
    expect(write.shouldAbort(write.plan(post())!)).toBe(true);
  });

  test("sign-in steps are recognised by path, operation name or host", () => {
    for (const yes of ["/oauth/token", "/shop/api/session-management/post-login", "/api/session/post-login", "/u/login", "/sign-in", "signIn", "loginUser", "/connect/authorize", "/saml2/acs"]) {
      expect(isLoginFlow(yes), yes).toBe(true);
    }
    for (const no of ["/api/notes", "/api/authors", "/assortment", "addNote", "/api/quotes", "createQuote", "/api/tokenized-cards-x"]) {
      expect(isLoginFlow(no), no).toBe(false);
    }
    const r = new CaptureRecorder({ origin });
    const post = (url: string, body: unknown = {}) => req({ url, method: "POST", postData: json(body) });
    const token = r.plan(post(`${origin}/oauth/token`))!;
    expect(token.loginFlow).toBe(true);
    expect(token.calls[0]!.shape.loginFlow).toBe(true);
    expect(r.shouldAbort(token)).toBe(false);
    expect(r.shouldAbort(r.plan(post("https://login.shop.example/u/password"))!)).toBe(false);
    expect(r.shouldAbort(r.plan(post("https://id.shop.example/x"))!)).toBe(false);
    expect(r.shouldAbort(r.plan(post(`${origin}/graphql`, { query: "mutation signInUser { signInUser { ok } }" }))!)).toBe(false);
    expect(r.shouldAbort(r.plan(post(`${origin}/graphql`, [{ query: "mutation signIn { a }" }, { query: "mutation addNote { b }" }]))!)).toBe(true);
    const quote = r.plan(post(`${origin}/api/quotes`))!;
    expect(quote.loginFlow).toBe(false);
    expect(quote.calls[0]!.shape.loginFlow).toBeUndefined();
    expect(r.shouldAbort(quote)).toBe(true);
    expect(r.plan(req({ url: `${origin}/api/session` }))!.loginFlow).toBe(false); // reads need no exemption

    const write = new CaptureRecorder({ origin, allowWrite: true });
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
