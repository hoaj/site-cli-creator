// Tests for the fixture website (fixtures/site) and the expected agent code
// (fixtures/expected) the end-to-end tests copy into a generated skill: the
// site on its own, the expected code against a stand-in runtime, and the
// expected code on the real Starter runtime (sign-in, every Drift class, check).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { z } from "zod";
import { copyExpected, fillTokens, OPERATION_NAMES } from "../fixtures/expected/copy";
import { ACCOUNT, INVOICES, USER } from "../fixtures/site/data";
import { loginOriginFor } from "../fixtures/site/hosts";
import { DRIFTS, startFixtureSite, type Drift, type FixtureSite } from "../fixtures/site/server";

const PLUGIN_ROOT = resolve(import.meta.dir, "../../..");
const STARTER_CLI = resolve(import.meta.dir, "../starter/skill/cli");
const CHROME = process.env.SITE_CLI_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HAS_CHROME = existsSync(CHROME);

// ---- plain HTTP clients for both auth modes ---------------------------------

type Headers = Record<string, string>;

function cookieFrom(res: Response, name: string): string {
  const hit = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  if (!hit) throw new Error(`no ${name} cookie`);
  return hit.split(";")[0]!;
}

function decodeJwt(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
}

/** Signs in on the login host and follows the code back to the site, then requests a token, as the browser does. */
async function loginHeaders(site: FixtureSite): Promise<Headers> {
  const login = await fetch(`${site.loginUrl}/login?autologin=1`, { redirect: "manual" });
  expect(login.status).toBe(303);
  const callback = login.headers.get("location")!;
  expect(callback.startsWith(`${site.url}/auth/callback?code=`)).toBe(true);
  const back = await fetch(callback, { redirect: "manual" });
  expect(back.status).toBe(303);
  const cookie = cookieFrom(back, "shop_sid");
  const token = await fetch(`${site.url}/oauth/token`, { method: "POST", headers: { cookie } });
  expect(token.status).toBe(200);
  const { access_token } = (await token.json()) as { access_token: string };
  return { authorization: `Bearer ${access_token}`, cookie };
}

async function csrfHeaders(site: FixtureSite): Promise<Headers> {
  const front = await fetch(`${site.url}/`);
  expect(front.status).toBe(200);
  const cookie = cookieFrom(front, "csrf_token");
  return { cookie, "x-csrf-token": cookie.split("=")[1]! };
}

async function gql(site: FixtureSite, headers: Headers, operationName: string, query: string, variables: object = {}) {
  const res = await fetch(`${site.url}/graphql`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ operationName, query, variables }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const ACCOUNT_Q = "query getAccount($customerId: ID) { getAccount(customerId: $customerId) { id name email phone } }";
const SUBS_Q = "query listSubscriptions($accountId: ID!) { listSubscriptions(accountId: $accountId) { id status startDate price features { code } } }";
const NOTE_Q = "mutation addNote($accountId: ID!, $text: String!) { addNote(accountId: $accountId, text: $text) { id text } }";
const NOTE_BODY_Q = "mutation addNote($accountId: ID!, $body: String!) { addNote(accountId: $accountId, body: $body) { id text } }";

// ---- the server --------------------------------------------------------------

describe("fixture site, auth none", () => {
  let site: FixtureSite;
  beforeAll(() => {
    site = startFixtureSite({ auth: "none" });
  });
  afterAll(() => site.stop());

  test("the front page sets a readable csrf cookie and serves the frontend", async () => {
    const res = await fetch(`${site.url}/`);
    expect(res.headers.getSetCookie()[0]).toMatch(/^csrf_token=\w+; Path=\/; SameSite=Strict$/);
    expect(await res.text()).toContain('id="add-note"');
    const again = await fetch(`${site.url}/`, { headers: { cookie: cookieFrom(res, "csrf_token") } });
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  test("data APIs answer 403 without a matching x-csrf-token header", async () => {
    const h = await csrfHeaders(site);
    expect((await gql(site, {}, "getAccount", ACCOUNT_Q)).status).toBe(403);
    expect((await gql(site, { cookie: h.cookie! }, "getAccount", ACCOUNT_Q)).status).toBe(403);
    expect((await gql(site, { ...h, "x-csrf-token": "forged" }, "getAccount", ACCOUNT_Q)).status).toBe(403);
    expect((await gql(site, { cookie: "csrf_token=unknown", "x-csrf-token": "unknown" }, "getAccount", ACCOUNT_Q)).status).toBe(403);
    expect((await fetch(`${site.url}/api/invoices?accountId=${ACCOUNT.id}`, { headers: { cookie: h.cookie! } })).status).toBe(403);
    expect((await gql(site, h, "getAccount", ACCOUNT_Q)).status).toBe(200);
  });

  test("GraphQL answers only the selected fields, with nulls, arrays, aliases and __typename", async () => {
    const h = await csrfHeaders(site);
    const account = await gql(site, h, "getAccount", ACCOUNT_Q);
    expect(account.body).toEqual({ data: { getAccount: { id: ACCOUNT.id, name: ACCOUNT.name, email: ACCOUNT.email, phone: null } } });
    const subs = (await gql(site, h, "listSubscriptions", SUBS_Q, { accountId: ACCOUNT.id })).body.data.listSubscriptions;
    expect(Object.keys(subs[0]).sort()).toEqual(["features", "id", "price", "startDate", "status"]);
    expect(subs.some((s: any) => s.price === null && s.startDate === null)).toBe(true);
    expect(subs.some((s: any) => s.features.length > 0)).toBe(true);
    expect(subs.some((s: any) => s.status !== "active")).toBe(true);
    const aliased = await gql(site, h, "a", 'query a { who: getAccount { __typename id } subs: listSubscriptions(accountId: "A-55102") { id } }');
    expect(aliased.body.data.who).toEqual({ __typename: "Account", id: ACCOUNT.id });
    expect(aliased.body.data.subs.length).toBe(4);
  });

  test("unknown fields and arguments, syntax errors and missing variables are rejected like a GraphQL server", async () => {
    const h = await csrfHeaders(site);
    const validation = async (query: string) => {
      const res = await gql(site, h, "q", query);
      expect(res.status).toBe(400);
      expect(res.body.errors[0].extensions.code).toBe("GRAPHQL_VALIDATION_FAILED");
      return res.body.errors[0].message as string;
    };
    expect(await validation("query q { getAccount { id bogus } }")).toBe('Cannot query field "bogus" on type "Account".');
    expect(await validation('query q { getAccount(customer: "C-1") { id } }')).toBe('Unknown argument "customer" on field "Query.getAccount".');
    expect(await validation("query q { listSubscriptions { id } }")).toBe(
      'Field "listSubscriptions" argument "accountId" of type "ID!" is required, but it was not provided.',
    );
    expect(await validation("query q { getAccount }")).toBe('Field "getAccount" of type "Account" must have a selection of subfields.');
    expect(await validation("query q($x: ID) { getAccount(customerId: $y) { id } }")).toBe('Variable "$y" is not defined by operation "q".');
    expect((await gql(site, h, "q", "query q { getAccount { id ")).body.errors[0].extensions.code).toBe("GRAPHQL_PARSE_FAILED");
    expect((await gql(site, h, "q", "query q { ...F }")).body.errors[0].extensions.code).toBe("GRAPHQL_PARSE_FAILED");
    expect((await gql(site, h, "other", "query q { getAccount { id } }")).body.errors[0].message).toBe("Unknown operation.");
    const missing = await gql(site, h, "listSubscriptions", SUBS_Q);
    expect(missing.status).toBe(400);
    expect(missing.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    const wrongAccount = await gql(site, h, "listSubscriptions", SUBS_Q, { accountId: "A-0" });
    expect(wrongAccount.status).toBe(200);
    expect(wrongAccount.body).toEqual({
      data: { listSubscriptions: null },
      errors: [{ message: "Account not found.", path: ["listSubscriptions"], extensions: { code: "NOT_FOUND" } }],
    });
    const notJson = await fetch(`${site.url}/graphql`, { method: "POST", headers: h, body: "{" });
    expect(notJson.status).toBe(400);
  });

  test("POST /__drift switches Drift at run time, only when control is on, and sessions survive it", async () => {
    expect((await fetch(`${site.url}/__drift?name=auth`, { method: "POST" })).status).toBe(404); // no control in tests' site
    const live = startFixtureSite({ auth: "login", control: true });
    try {
      const h = await loginHeaders(live);
      const invoices = () => fetch(`${live.url}/api/invoices?accountId=${ACCOUNT.id}`, { headers: h, redirect: "manual" });
      expect((await invoices()).status).toBe(200);
      const on = await fetch(`${live.url}/__drift?name=remove-rest`, { method: "POST" });
      expect(await on.json()).toEqual({ drift: "remove-rest" });
      expect((await fetch(`${live.url}/api/invoices/${INVOICES[0]!.id}`, { headers: h, redirect: "manual" })).status).toBe(404);
      expect((await fetch(`${live.url}/__drift?name=none`, { method: "POST" })).status).toBe(200);
      expect((await fetch(`${live.url}/api/invoices/${INVOICES[0]!.id}`, { headers: h, redirect: "manual" })).status).toBe(200);
      expect((await invoices()).status).toBe(200); // still signed in
      expect((await fetch(`${live.url}/__drift?name=bogus`, { method: "POST" })).status).toBe(400);
    } finally {
      live.stop();
    }
  });

  test("REST lists invoices and returns one with nullable fields and lines", async () => {
    const h = await csrfHeaders(site);
    const list = (await (await fetch(`${site.url}/api/invoices?accountId=${ACCOUNT.id}`, { headers: h })).json()) as any;
    expect(list.invoices.map((i: any) => i.id)).toEqual(INVOICES.map((i) => i.id));
    expect(list.invoices[0].lines).toBeUndefined();
    const one = (await (await fetch(`${site.url}/api/invoices/${INVOICES[1]!.id}`, { headers: h })).json()) as any;
    expect(one.dueDate).toBeNull();
    expect(one.lines.length).toBe(3);
    expect((await fetch(`${site.url}/api/invoices/INV-nope`, { headers: h })).status).toBe(404);
    expect((await fetch(`${site.url}/api/invoices?accountId=A-0`, { headers: h })).status).toBe(400);
  });

  test("addNote stores the note and validates its text", async () => {
    const h = await csrfHeaders(site);
    const before = site.notes().length;
    const res = await gql(site, h, "addNote", NOTE_Q, { accountId: ACCOUNT.id, text: "Ring efter kl. 17" });
    expect(res.body.data.addNote.text).toBe("Ring efter kl. 17");
    expect(site.notes().length).toBe(before + 1);
    expect(site.requests().at(-1)).toEqual({ method: "POST", host: new URL(site.url).host, path: "/graphql", operationName: "addNote" });
    const blank = await gql(site, h, "addNote", NOTE_Q, { accountId: ACCOUNT.id, text: "  " });
    expect(blank.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    expect(site.notes().length).toBe(before + 1);
  });

  test("the request log names each GraphQL request's own operation, even when requests overlap", async () => {
    const h = await csrfHeaders(site);
    const from = site.requests().length;
    await Promise.all([
      gql(site, h, "getAccount", ACCOUNT_Q),
      gql(site, h, "listSubscriptions", SUBS_Q, { accountId: ACCOUNT.id }),
      fetch(`${site.url}/api/invoices?accountId=${ACCOUNT.id}`, { headers: h }),
      gql(site, h, "getAccount", ACCOUNT_Q),
    ]);
    const seen = site.requests().slice(from);
    expect(seen.filter((r) => r.path === "/graphql").map((r) => r.operationName).sort()).toEqual(["getAccount", "getAccount", "listSubscriptions"]);
    expect(seen.find((r) => r.path === "/api/invoices")!.operationName).toBeUndefined();
  });

  test("there is no login in public mode, on either host", async () => {
    expect((await fetch(`${site.url}/login`)).status).toBe(404);
    expect((await fetch(`${site.url}/oauth/token`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${site.url}/auth/callback?code=x`)).status).toBe(404);
    expect((await fetch(`${site.loginUrl}/login?autologin=1`, { redirect: "manual" })).status).toBe(404);
  });
});

describe("fixture site, auth login", () => {
  let site: FixtureSite;
  beforeAll(() => {
    site = startFixtureSite({ auth: "login" });
  });
  afterAll(() => site.stop());

  test("sign-in lives on a separate login host of the same server", () => {
    expect(site.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(site.loginUrl).toBe(site.url.replace("127.0.0.1", "localhost"));
    expect(loginOriginFor(site.url)).toBe(site.loginUrl);
    expect(() => loginOriginFor("http://example.com")).toThrow(/127\.0\.0\.1/);
  });

  test("the account page redirects to the login host without a session", async () => {
    const res = await fetch(`${site.url}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${site.loginUrl}/login`);
    expect(await (await fetch(`${site.loginUrl}/login`)).text()).toContain('name="password"');
    expect((await fetch(`${site.url}/login`)).status).toBe(404);
    expect((await fetch(`${site.loginUrl}/graphql`, { method: "POST" })).status).toBe(404);
  });

  test("the login form accepts test/test only, and its code works once", async () => {
    const post = (username: string, password: string) =>
      fetch(`${site.loginUrl}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
    const wrong = await post("test", "wrong");
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('role="alert"');
    const ok = await post(USER.username, USER.password);
    expect(ok.status).toBe(303);
    const callback = ok.headers.get("location")!;
    const back = await fetch(callback, { redirect: "manual" });
    expect(back.headers.get("location")).toBe("/");
    expect(cookieFrom(back, "shop_sid")).toMatch(/^shop_sid=\w+$/);
    const replay = await fetch(callback, { redirect: "manual" });
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toBe(`${site.loginUrl}/login`);
    expect(replay.headers.getSetCookie()).toEqual([]);
  });

  test("the bearer is JWT-shaped with account_ref and person_ref claims", async () => {
    const { authorization } = await loginHeaders(site);
    const claims = decodeJwt(authorization!.slice("Bearer ".length));
    expect(claims.account_ref).toBe(USER.accountRef);
    expect(claims.person_ref).toBe(USER.personRef);
    expect((await fetch(`${site.url}/oauth/token`, { method: "POST" })).status).toBe(401);
  });

  test("data APIs need both the bearer and the session cookie", async () => {
    const h = await loginHeaders(site);
    const other = await loginHeaders(site);
    const vars = { customerId: USER.customerId };
    expect((await gql(site, {}, "getAccount", ACCOUNT_Q, vars)).status).toBe(401);
    expect((await gql(site, { authorization: h.authorization! }, "getAccount", ACCOUNT_Q, vars)).status).toBe(401);
    expect((await gql(site, { cookie: h.cookie! }, "getAccount", ACCOUNT_Q, vars)).status).toBe(401);
    expect((await gql(site, { authorization: h.authorization!, cookie: other.cookie! }, "getAccount", ACCOUNT_Q, vars)).status).toBe(401);
    expect((await fetch(`${site.url}/api/invoices?accountId=${ACCOUNT.id}`, { headers: { cookie: h.cookie! }, redirect: "manual" })).status).toBe(401);
    expect((await gql(site, h, "getAccount", ACCOUNT_Q, vars)).status).toBe(200);
  });

  test("a signed-out REST read is redirected to the login host", async () => {
    const res = await fetch(`${site.url}/api/invoices?accountId=${ACCOUNT.id}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${site.loginUrl}/login`);
  });

  test("post-login turns the token claims into the customerId the chain starts from", async () => {
    const h = await loginHeaders(site);
    const claims = decodeJwt(h.authorization!.slice(7));
    const postLogin = (body: object, headers: Headers = h) =>
      fetch(`${site.url}/api/session/post-login`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const res = await postLogin({ accountRef: claims.account_ref, personRef: claims.person_ref });
    const body = (await res.json()) as any;
    expect(Object.keys(body.personalInfo).sort()).toEqual(["cpr", "customerId", "email", "phone"]);
    expect(body.personalInfo.customerId).toBe(USER.customerId);
    expect((await postLogin({ accountRef: "acc_x", personRef: claims.person_ref })).status).toBe(403);
    expect((await postLogin({ accountRef: claims.account_ref, personRef: claims.person_ref }, { cookie: h.cookie! })).status).toBe(401);

    // The chain: customerId → getAccount → accountId → listSubscriptions.
    const wrong = await gql(site, h, "getAccount", ACCOUNT_Q, { customerId: "C-1" });
    expect(wrong.body.errors[0].extensions.code).toBe("FORBIDDEN");
    const account = await gql(site, h, "getAccount", ACCOUNT_Q, { customerId: body.personalInfo.customerId });
    const subs = await gql(site, h, "listSubscriptions", SUBS_Q, { accountId: account.body.data.getAccount.id });
    expect(subs.body.data.listSubscriptions.length).toBe(4);
  });

  test("revokeTokens invalidates bearers but keeps the login session", async () => {
    const h = await loginHeaders(site);
    site.revokeTokens();
    expect((await gql(site, h, "getAccount", ACCOUNT_Q, { customerId: USER.customerId })).status).toBe(401);
    const token = await fetch(`${site.url}/oauth/token`, { method: "POST", headers: { cookie: h.cookie! } });
    expect(token.status).toBe(200);
  });

  test("blockSignIn makes every sign-in fail until it is lifted", async () => {
    site.blockSignIn(true);
    try {
      const auto = await fetch(`${site.loginUrl}/login?autologin=1`, { redirect: "manual" });
      expect(auto.status).toBe(200);
      expect(await auto.text()).toContain('role="alert"');
      const form = new URLSearchParams({ username: USER.username, password: USER.password });
      expect((await fetch(`${site.loginUrl}/login`, { method: "POST", body: form, redirect: "manual" })).status).toBe(503);
    } finally {
      site.blockSignIn(false);
    }
    expect((await fetch(`${site.loginUrl}/login?autologin=1`, { redirect: "manual" })).status).toBe(303);
  });

  test("the login host remembers a sign-in in a cookie: it signs in again at once, even while blockSignIn holds, until revokeSessions", async () => {
    const first = await fetch(`${site.loginUrl}/login?autologin=1`, { redirect: "manual" });
    expect(first.status).toBe(303);
    const idp = first.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith("idp_sid="));
    expect(idp).toBeDefined();
    expect(first.headers.getSetCookie().find((c) => c.startsWith("idp_sid="))).toContain("Max-Age=");
    site.blockSignIn(true);
    try {
      const again = await fetch(`${site.loginUrl}/login`, { headers: { cookie: idp! }, redirect: "manual" });
      expect(again.status).toBe(303);
      expect(again.headers.get("location")).toStartWith(`${site.url}/auth/callback?code=`);
      expect((await fetch(`${site.loginUrl}/login`, { redirect: "manual" })).status).toBe(200);
    } finally {
      site.blockSignIn(false);
    }
    site.revokeSessions();
    expect((await fetch(`${site.loginUrl}/login`, { headers: { cookie: idp! }, redirect: "manual" })).status).toBe(200);
  });

  test("revokeSessions ends the session: REST redirects to sign-in, GraphQL answers 401", async () => {
    const h = await loginHeaders(site);
    site.revokeSessions();
    const rest = await fetch(`${site.url}/api/invoices/${INVOICES[0]!.id}`, { headers: h, redirect: "manual" });
    expect(rest.status).toBe(302);
    expect(rest.headers.get("location")).toBe(`${site.loginUrl}/login`);
    expect((await gql(site, h, "getAccount", ACCOUNT_Q, { customerId: USER.customerId })).status).toBe(401);
    expect((await fetch(`${site.url}/`, { headers: h, redirect: "manual" })).status).toBe(302);
    expect((await fetch(`${site.url}/oauth/token`, { method: "POST", headers: { cookie: h.cookie! } })).status).toBe(401);
  });
});

describe("drift switches", () => {
  const sites: FixtureSite[] = [];
  afterAll(() => sites.forEach((s) => s.stop()));

  /** One observation of the site that every switch must change. */
  async function observe(site: FixtureSite) {
    const h = site.auth === "login" ? await loginHeaders(site) : await csrfHeaders(site);
    const accountVars = site.auth === "login" ? { customerId: USER.customerId } : {};
    const account = await gql(site, h, "getAccount", ACCOUNT_Q, accountVars);
    const subs = await gql(site, h, "listSubscriptions", SUBS_Q, { accountId: ACCOUNT.id });
    const one = await fetch(`${site.url}/api/invoices/${INVOICES[0]!.id}`, { headers: h });
    const note = await gql(site, h, "addNote", NOTE_Q, { accountId: ACCOUNT.id, text: "x" });
    const page = await (await fetch(`${site.url}/`, { headers: h })).text();
    return {
      account: { status: account.status, body: account.body },
      subs: { status: subs.status, body: subs.body },
      invoice: one.status,
      note: { status: note.status, errors: note.body.errors },
      page: { label: /<label for="note-text">([^<]*)</.exec(page)?.[1], sendsBody: page.includes("$body") },
    };
  }

  for (const auth of ["none", "login"] as const) {
    test(`every switch changes behaviour (auth ${auth}), and null restores it`, async () => {
      const site = startFixtureSite({ auth });
      sites.push(site);
      const normal = await observe(site);
      expect(normal.subs.status).toBe(200);
      expect(normal.invoice).toBe(200);
      expect(normal.note).toEqual({ status: 200, errors: undefined });
      expect(normal.page).toEqual({ label: "Ny note", sendsBody: false });
      const at = async (drift: Drift) => {
        site.setDrift(drift);
        try {
          return await observe(site);
        } finally {
          site.setDrift(null);
        }
      };

      const renamed = (await at("rename-field")).subs.body.data.listSubscriptions;
      expect(renamed.every((s: any) => !("status" in s) && typeof s.state === "string")).toBe(true);

      const retyped = (await at("type-change")).subs.body.data.listSubscriptions;
      expect(retyped.map((s: any) => s.price)).toEqual(normal.subs.body.data.listSubscriptions.map((s: any) => (s.price === null ? null : s.price.toFixed(2))));

      const removed = await at("remove-rest");
      expect(removed.invoice).toBe(404);
      expect(removed.subs.status).toBe(200);

      const invalid = (await at("graphql-validation")).subs;
      expect(invalid.status).toBe(400);
      expect(invalid.body.errors[0]).toEqual({
        message: 'Cannot query field "price" on type "Subscription".',
        extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
      });

      const reshaped = await at("write-shape");
      expect(reshaped.note.status).toBe(400);
      expect(reshaped.note.errors.map((e: any) => e.message)).toEqual([
        'Unknown argument "text" on field "Mutation.addNote".',
        'Field "addNote" argument "body" of type "String!" is required, but it was not provided.',
      ]);
      expect(reshaped.page.sendsBody).toBe(true);
      expect(reshaped.subs.status).toBe(200);

      const ui = await at("ui-change");
      expect(ui.page.label).toBe("Skriv en besked");
      expect(ui.note.status).toBe(200);

      for (const [drift, status] of [["auth", 401], ["server-error", 500], ["rate-limit", 429]] as const) {
        const seen = await at(drift);
        expect([seen.account.status, seen.subs.status, seen.invoice, seen.note.status]).toEqual([status, status, status, status]);
      }

      const rejected = await at("input-rejected");
      expect(rejected.subs.status).toBe(400);
      expect(rejected.subs.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
      expect(rejected.subs.body.errors[0].message).not.toContain(ACCOUNT.id);
      expect(rejected.invoice).toBe(400);

      const { note: _note, ...again } = await observe(site);
      const { note: _n, ...base } = normal;
      expect(again).toEqual(base);
    });
  }

  test("write-shape: the new mutation shape is what the site now accepts", async () => {
    const site = startFixtureSite({ auth: "none" });
    sites.push(site);
    site.setDrift("write-shape");
    const res = await gql(site, await csrfHeaders(site), "addNote", NOTE_BODY_Q, { accountId: ACCOUNT.id, body: "ny form" });
    expect(res.body.data.addNote.text).toBe("ny form");
  });

  test("the auth switch leaves the login flow itself working, so it reads as Drift after a fresh login", async () => {
    const site = startFixtureSite({ auth: "login" });
    sites.push(site);
    site.setDrift("auth");
    const h = await loginHeaders(site);
    const res = await fetch(`${site.url}/api/session/post-login`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ accountRef: USER.accountRef, personRef: USER.personRef }),
    });
    expect(res.status).toBe(200);
  });

  test("unknown switches are refused", () => {
    const site = startFixtureSite({ auth: "none" });
    sites.push(site);
    expect(() => site.setDrift("nope" as Drift)).toThrow(/unknown drift/);
    expect(DRIFTS.length).toBe(10);
  });
});

describe("server.ts as a script", () => {
  const SERVER = join(import.meta.dir, "../fixtures/site/server.ts");

  test("prints its URLs as JSON and serves, with a drift switched on", async () => {
    const proc = Bun.spawn(["bun", SERVER, "--auth", "none", "--port", "0", "--drift", "remove-rest"], { stdout: "pipe", stderr: "pipe" });
    try {
      const { value } = await proc.stdout.getReader().read();
      const info = JSON.parse(new TextDecoder().decode(value).trim().split("\n")[0]!) as { url: string; loginUrl: string; auth: string; drift: string };
      expect(info).toMatchObject({ auth: "none", drift: "remove-rest" });
      expect(info.loginUrl).toBe(loginOriginFor(info.url));
      expect((await fetch(`${info.url}/`)).status).toBe(200);
    } finally {
      proc.kill();
    }
  });

  for (const [what, args] of [
    ["a missing --auth", []],
    ["an unknown drift", ["--auth", "none", "--drift", "nope"]],
    ["a bad port", ["--auth", "login", "--port", "x"]],
  ] as const) {
    test(`rejects ${what} with exit 2 and a usage line`, async () => {
      const proc = Bun.spawn(["bun", SERVER, ...args], { stdout: "pipe", stderr: "pipe" });
      expect(await proc.exited).toBe(2);
      expect(await new Response(proc.stderr).text()).toContain("usage: bun fixtures/site/server.ts");
    });
  }
});

// ---- the expected agent code -------------------------------------------------

const TOKENS = (auth: "login" | "none", origin: string) => ({
  plugin: "shop",
  skill: `shop-${auth}`,
  repo: "acme/shop-plugin",
  generatorVersion: "0.1.0",
  origin,
});

describe("copyExpected", () => {
  test("fills every token, derives the login host, and refuses leftovers", () => {
    const filled = fillTokens('"__ORIGIN__" "__LOGIN_ORIGIN__" "__LOGIN_HOST__" __PLUGIN__:__SKILL__ __REPO__ __GENERATOR_VERSION__', TOKENS("login", "http://127.0.0.1:4100/"));
    expect(filled).toBe('"http://127.0.0.1:4100" "http://localhost:4100" "localhost:4100" shop:shop-login acme/shop-plugin 0.1.0');
    expect(() => fillTokens("__OWNER__", TOKENS("none", "http://127.0.0.1:1"))).toThrow(/unfilled placeholder __OWNER__/);
  });
});

/**
 * Loads the expected code with a minimal stand-in runtime (the define*
 * functions are identities) so its Contracts can be checked against the
 * fixture site independently of the Starter code.
 */
async function loadExpected(auth: "login" | "none", origin: string) {
  const dir = mkdtempSync(join(tmpdir(), `fixture-expected-${auth}-`));
  symlinkSync(join(PLUGIN_ROOT, "node_modules"), join(dir, "node_modules"));
  const src = join(dir, "src");
  mkdirSync(join(src, "runtime"), { recursive: true });
  for (const name of ["site", "operation", "command"]) {
    const fn = `define${name[0]!.toUpperCase()}${name.slice(1)}`;
    writeFileSync(join(src, "runtime", `${name}.ts`), `export const ${fn} = <T>(x: T): T => x;\n`);
  }
  // Commands end with an input error through the runtime's helper.
  writeFileSync(
    join(src, "runtime", "command.ts"),
    "export const defineCommand = <T>(x: T): T => x;\nexport const inputFailure = (message: string): never => { throw Object.assign(new Error(message), { kind: \"input\" }); };\n",
  );
  const files = copyExpected(auth, src, TOKENS(auth, origin));
  return { dir, src, files, ...(await importExpected(src)) };
}

async function importExpected(src: string) {
  const load = async (rel: string) => (await import(join(src, rel))).default;
  const op = (n: string) => load(`operations/${n}.ts`);
  const cmd = (n: string) => load(`commands/${n}.ts`);
  return {
    site: await load("site.ts"),
    ops: {
      getAccount: await op("getAccount"),
      listSubscriptions: await op("listSubscriptions"),
      listInvoices: await op("listInvoices"),
      getInvoice: await op("getInvoice"),
      addNote: await op("addNote"),
    },
    commands: {
      subscriptionShow: await cmd("subscription-show"),
      invoiceList: await cmd("invoice-list"),
      invoiceShow: await cmd("invoice-show"),
      noteAdd: await cmd("note-add"),
    },
  };
}

type Op = { name: string; effect: string; graphql?: string; rest?: any; variables: z.ZodType; response: z.ZodType; needs?: any; trigger?: (p: Page) => Promise<void> };

/** A bare-bones ctx.call: validates variables, performs the call, parses the response with the Contract. */
function makeCall(origin: string, headers: Headers) {
  return async (op: Op, vars: unknown) => {
    const variables = op.variables.parse(vars) as Record<string, string>;
    let res: Response;
    if (op.graphql) {
      res = await fetch(`${origin}/graphql`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ operationName: op.name, query: op.graphql, variables }),
      });
    } else {
      const path = (op.rest.path as string).replace(/:(\w+)/g, (_, k) => encodeURIComponent(variables[k]!));
      const query = op.rest.query ? `?${new URLSearchParams(op.rest.query(variables))}` : "";
      res = await fetch(`${origin}${path}${query}`, { method: op.rest.method, headers });
    }
    if (!res.ok) throw new Error(`${op.name}: HTTP ${res.status}`);
    const body = (await res.json()) as any;
    if (body.errors) throw new Error(`${op.name}: ${body.errors[0].extensions.code}`);
    return op.response.parse(body);
  };
}

const ctxFetch = (url: string | URL | Request, init?: RequestInit) => fetch(url, init);

for (const auth of ["none", "login"] as const) {
  describe(`expected code, auth ${auth}`, () => {
    let site: FixtureSite;
    let x: Awaited<ReturnType<typeof loadExpected>>;
    let headers: Headers;
    let ids: Record<string, string>;

    beforeAll(async () => {
      site = startFixtureSite({ auth });
      x = await loadExpected(auth, site.url);
      if (auth === "login") {
        headers = await loginHeaders(site);
        ids = await x.site.login.postLogin({ fetch: ctxFetch, origin: site.url, headers, ids: {}, decodeJwt });
      } else {
        headers = (await x.site.bootstrap({ fetch: ctxFetch, origin: site.url, headers: {}, ids: {}, decodeJwt })).headers;
        ids = {};
      }
    });
    afterAll(() => {
      site.stop();
      rmSync(x.dir, { recursive: true, force: true });
    });

    const ctx = () => ({ call: makeCall(site.url, headers), session: { headers, ids }, note: () => {} });

    test("copies with every placeholder filled and ../runtime imports", () => {
      expect(x.files).toEqual([
        "site.ts",
        "operations/addNote.ts",
        "operations/getAccount.ts",
        "operations/getInvoice.ts",
        "operations/listInvoices.ts",
        "operations/listSubscriptions.ts",
        "commands/invoice-list.ts",
        "commands/invoice-show.ts",
        "commands/note-add.ts",
        "commands/subscription-show.ts",
      ]);
      for (const f of x.files) {
        const text = readFileSync(join(x.src, f), "utf8");
        expect(text).not.toMatch(/__[A-Z_]+__/);
        const runtimeImports = [...text.matchAll(/from "(\.{1,2}\/runtime\/\w+)"/g)].map((m) => m[1]!);
        expect(runtimeImports.length).toBeGreaterThan(0);
        for (const imp of runtimeImports) expect(existsSync(join(x.src, f, "..", `${imp}.ts`))).toBe(true);
      }
      expect(x.site).toMatchObject({ plugin: "shop", skill: `shop-${auth}`, repo: "acme/shop-plugin", origin: site.url, auth });
    });

    test("site.ts sets up the session the mode needs", () => {
      if (auth === "login") {
        expect(x.site.login.startUrl).toBe(`${site.loginUrl}/login?autologin=1`);
        expect(x.site.login.hosts).toEqual([new URL(site.loginUrl).host]);
        expect(x.site.login.hosts).not.toContain(new URL(site.url).host);
        expect(x.site.login.tokenRequest).toBe("/graphql");
        expect(ids).toEqual({ customerId: USER.customerId }); // nothing personal is kept
        expect(x.site.bootstrap).toBeUndefined();
      } else {
        expect(Object.keys(headers).sort()).toEqual(["cookie", "x-csrf-token"]);
        expect(x.site.login).toBeUndefined();
      }
    });

    test("Contracts declare names, effects and the chain", () => {
      for (const [file, name] of Object.entries(OPERATION_NAMES)) expect(x.ops[file as keyof typeof x.ops].name).toBe(name);
      expect(Object.values(x.ops).filter((o: any) => o.effect === "write").map((o: any) => o.name)).toEqual(["addNote"]);
      expect(typeof x.ops.addNote.trigger).toBe("function");
      for (const op of Object.values(x.ops) as Op[]) if (op.name !== "addNote") expect(op.trigger).toBeUndefined();
      expect(x.ops.listSubscriptions.needs.accountId.from).toBe("getAccount");
      expect(x.ops.getInvoice.needs.id.from).toBe(OPERATION_NAMES.listInvoices);
      if (auth === "login") expect(x.ops.getAccount.needs.customerId).toEqual({ from: "session", key: "customerId" });
      else expect(x.ops.getAccount.needs).toBeUndefined();
    });

    test("commands produce their output from the live fixture", async () => {
      const shown = await x.commands.subscriptionShow.run({ all: false }, ctx());
      expect(shown.customer).toBe(ACCOUNT.name);
      expect(shown.subscriptions.map((s: any) => s.status)).toEqual(["active", "active", "active"]);
      expect(shown.subscriptions.some((s: any) => s.monthlyDKK === null && s.since === null)).toBe(true);
      expect(shown.monthlyTotalDKK).toBe(728.5);
      expect((await x.commands.subscriptionShow.run({ all: true }, ctx())).subscriptions.length).toBe(4);

      const list = await x.commands.invoiceList.run({}, ctx());
      expect(list.invoices.map((i: any) => i.id)).toEqual(INVOICES.map((i) => i.id));
      const one = await x.commands.invoiceShow.run({ id: list.invoices[1].id }, ctx());
      expect(one.due).toBeNull();
      expect(one.lines.length).toBe(3);

      const before = site.notes().length;
      const added = await x.commands.noteAdd.run({ text: "Fra CLI" }, ctx());
      expect(added.note.text).toBe("Fra CLI");
      expect(site.notes().length).toBe(before + 1);
    });

    test("command flags are validated by their schemas", () => {
      expect(x.commands.invoiceShow.args.safeParse({}).success).toBe(false);
      expect(x.commands.noteAdd.args.safeParse({ text: "" }).success).toBe(false);
      expect(x.commands.noteAdd.args.safeParse({ text: "x".repeat(501) }).success).toBe(false);
      expect(x.commands.subscriptionShow.args.parse({})).toEqual({ all: false });
    });

    test("needs pick the next variable from the previous result", async () => {
      const call = makeCall(site.url, headers);
      const account = await call(x.ops.getAccount, auth === "login" ? { customerId: ids.customerId } : {});
      expect(x.ops.listSubscriptions.needs.accountId.pick(account)).toBe(ACCOUNT.id);
      expect(x.ops.listInvoices.needs.accountId.pick(account)).toBe(ACCOUNT.id);
      expect(x.ops.addNote.needs.accountId.pick(account)).toBe(ACCOUNT.id);
      const invoices = await call(x.ops.listInvoices, { accountId: ACCOUNT.id });
      expect(x.ops.getInvoice.needs.id.pick(invoices)).toBe(INVOICES[0]!.id);
    });

    test("Contracts break the way the e2e Fingerprints expect", async () => {
      const call = makeCall(site.url, headers);
      const issue = async (drift: Drift) => {
        site.setDrift(drift);
        try {
          await call(x.ops.listSubscriptions, { accountId: ACCOUNT.id });
          throw new Error("expected a parse failure");
        } catch (e: any) {
          const path = (i: any) => i.path.map((p: unknown) => (typeof p === "number" ? "[]" : p)).join(".").replaceAll(".[]", "[]");
          return e.issues?.map((i: any) => `${path(i)}:${i.code}`);
        } finally {
          site.setDrift(null);
        }
      };
      expect(new Set(await issue("rename-field"))).toEqual(new Set(["data.listSubscriptions[].status:invalid_type"]));
      expect(new Set(await issue("type-change"))).toEqual(new Set(["data.listSubscriptions[].price:invalid_type"]));
    });
  });
}

// ---- the expected code on the real Starter runtime ---------------------------

/** A temp CLI skill: the Starter runtime and tsconfig, plus the expected code for one auth mode. */
function scaffoldWithRuntime(auth: "login" | "none", origin: string) {
  const dir = mkdtempSync(join(tmpdir(), `fixture-runtime-${auth}-`));
  symlinkSync(join(PLUGIN_ROOT, "node_modules"), join(dir, "node_modules"));
  const src = join(dir, "src");
  cpSync(join(STARTER_CLI, "src", "runtime"), join(src, "runtime"), { recursive: true });
  cpSync(join(STARTER_CLI, "tsconfig.json"), join(dir, "tsconfig.json"));
  copyExpected(auth, src, TOKENS(auth, origin));
  return { dir, src };
}

describe("expected code type-checks against the Starter runtime", () => {
  for (const auth of ["none", "login"] as const) {
    test(`auth ${auth}`, async () => {
      const { dir } = scaffoldWithRuntime(auth, "http://127.0.0.1:4100");
      try {
        // Only the copied files: main.ts and registry.ts belong to other parts of the build.
        const tsconfig = JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8"));
        tsconfig.include = ["src/site.ts", "src/operations/*.ts", "src/commands/*.ts"];
        writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
        const proc = Bun.spawn([join(PLUGIN_ROOT, "node_modules/.bin/tsc"), "-p", dir], { stdout: "pipe", stderr: "pipe" });
        const out = await new Response(proc.stdout).text();
        expect(out).toBe("");
        expect(await proc.exited).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  }
});

type Failure = Error & { kind: string; fingerprint?: string; diff?: { path: string; code: string; received?: string }[]; drifts?: { operation: string; fingerprint: string }[] };

describe.skipIf(!HAS_CHROME)("expected code on the Starter runtime against the fixture", () => {
  for (const auth of ["none", "login"] as const) {
    describe(`auth ${auth}`, () => {
      let site: FixtureSite;
      let dir: string;
      let rt: { Client: any; check: any; chromeLogin: any; DryRun: any };
      let x: Awaited<ReturnType<typeof importExpected>>;
      let env: Record<string, string>;
      const prefix = `shop:shop-${auth}:`;

      beforeAll(async () => {
        site = startFixtureSite({ auth });
        const scaffold = scaffoldWithRuntime(auth, site.url);
        dir = scaffold.dir;
        env = { SITE_CLI_TEST: "1", SITE_CLI_HOME: join(dir, "state"), SITE_CLI_CHROME: CHROME };
        const r = (m: string) => import(join(scaffold.src, "runtime", `${m}.ts`));
        const [call, check, login, envelope] = await Promise.all([r("call"), r("check"), r("login"), r("envelope")]);
        rt = { Client: call.Client, check: check.check, chromeLogin: login.chromeLogin, DryRun: envelope.DryRun };
        x = await importExpected(scaffold.src);
      });
      afterAll(() => {
        site.stop();
        rmSync(dir, { recursive: true, force: true });
      });

      const client = (options: { confirm?: boolean } = {}) =>
        new rt.Client(
          x.site,
          {
            fetch: (u: string, i: RequestInit) => fetch(u, i),
            env,
            login: (headless: boolean) => rt.chromeLogin(x.site, { headless, env }),
            sleep: async () => {},
            retryDelays: [0],
            note: () => {},
          },
          options,
        );

      const run = async (command: any, args: object, options: { confirm?: boolean } = {}) => {
        const c = client(options);
        const session = await c.ensureSession();
        return command.run(command.args.parse(args), { call: c.call, session, note: () => {} });
      };

      const failure = async (p: Promise<unknown>): Promise<Failure> => {
        try {
          await p;
        } catch (e) {
          return e as Failure;
        }
        throw new Error("expected a failure");
      };

      const withDrift = async <T,>(drift: Drift, body: () => Promise<T>): Promise<T> => {
        site.setDrift(drift);
        try {
          return await body();
        } finally {
          site.setDrift(null);
        }
      };

      /** No value from the site may appear in a failure. */
      const valueFree = (f: Failure) => {
        const text = JSON.stringify({ message: f.message, fingerprint: f.fingerprint, diff: f.diff, drifts: f.drifts });
        for (const v of [ACCOUNT.id, ACCOUNT.name, USER.customerId, USER.cpr, USER.email, INVOICES[0]!.id, "Bredbånd"]) expect(text).not.toContain(v);
      };

      test("the session comes from Chrome sign-in (login) or bootstrap (none), keeping only chain-root ids", async () => {
        const session = await client().ensureSession();
        if (auth === "login") {
          expect(Object.keys(session.headers).sort()).toEqual(["authorization", "cookie"]);
          expect(session.ids).toEqual({ customerId: USER.customerId });
          expect(site.requests().some((r) => r.host === new URL(site.loginUrl).host && r.path === "/login")).toBe(true);
        } else {
          expect(Object.keys(session.headers).sort()).toEqual(["cookie", "x-csrf-token"]);
          expect(session.ids).toEqual({});
        }
        const saved = readFileSync(join(env.SITE_CLI_HOME!, "session.json"), "utf8");
        for (const v of [USER.cpr, USER.email]) expect(saved).not.toContain(v);
      }, 60_000);

      test("Task commands read through the chain", async () => {
        const shown = await run(x.commands.subscriptionShow, {});
        expect(shown).toMatchObject({ customer: ACCOUNT.name, monthlyTotalDKK: 728.5 });
        expect((await run(x.commands.invoiceList, {})).invoices.length).toBe(INVOICES.length);
        expect((await run(x.commands.invoiceShow, { id: INVOICES[0]!.id })).lines.length).toBe(2);
      }, 60_000);

      test("a write without --confirm is a dry run; with --confirm it writes once", async () => {
        const before = site.notes().length;
        const dry = await failure(run(x.commands.noteAdd, { text: "Fra CLI" }));
        expect(dry).toBeInstanceOf(rt.DryRun);
        expect((dry as any).operation).toBe("addNote");
        expect((dry as any).variables).toEqual({ accountId: ACCOUNT.id, text: "Fra CLI" });
        expect(site.notes().length).toBe(before);
        expect((await run(x.commands.noteAdd, { text: "Fra CLI" }, { confirm: true })).note.text).toBe("Fra CLI");
        expect(site.notes().length).toBe(before + 1);
      }, 60_000);

      test("every Drift switch is classified as Drift with its Fingerprint, and outages as network", async () => {
        const f = (drift: Drift, command: any, args: object, options = {}) => withDrift(drift, () => failure(run(command, args, options)));
        const expectations: [Drift, any, object, string, object?][] = [
          ["rename-field", x.commands.subscriptionShow, {}, `${prefix}listSubscriptions:zod:data.listSubscriptions[].status:invalid_type`],
          ["type-change", x.commands.subscriptionShow, {}, `${prefix}listSubscriptions:zod:data.listSubscriptions[].price:invalid_type`],
          ["graphql-validation", x.commands.subscriptionShow, {}, `${prefix}listSubscriptions:graphql:Subscription.price:GRAPHQL_VALIDATION_FAILED`],
          ["remove-rest", x.commands.invoiceShow, { id: INVOICES[0]!.id }, `${prefix}GET /api/invoices/{id}:http::404`],
          // The first call with variables is rejected: getAccount (login) or listSubscriptions (none, getAccount takes none).
          ["input-rejected", x.commands.subscriptionShow, {}, `${prefix}${auth === "login" ? "getAccount" : "listSubscriptions"}:input-rejected::BAD_USER_INPUT`],
          // invoice show checks the id against the list first, so the list call is the one rejected.
          ["input-rejected", x.commands.invoiceShow, { id: INVOICES[0]!.id }, `${prefix}${auth === "login" ? "getAccount:input-rejected::BAD_USER_INPUT" : "GET /api/invoices:input-rejected::400"}`],
          ["write-shape", x.commands.noteAdd, { text: "x" }, `${prefix}addNote:graphql:Mutation.addNote(text):GRAPHQL_VALIDATION_FAILED`, { confirm: true }],
          ["auth", x.commands.subscriptionShow, {}, `${prefix}getAccount:auth::401`],
        ];
        for (const [drift, command, args, fingerprint, options] of expectations) {
          const e = await f(drift, command, args, options);
          expect({ drift, kind: e.kind, fingerprint: e.fingerprint }).toEqual({ drift, kind: "drift", fingerprint });
          valueFree(e);
        }
        const rename = await f("rename-field", x.commands.subscriptionShow, {});
        expect(rename.diff![0]).toMatchObject({ path: "data.listSubscriptions[].status", code: "invalid_type", received: "undefined" });
        const retype = await f("type-change", x.commands.subscriptionShow, {});
        expect(retype.diff!.map((d) => d.received)).toContain("string");
        for (const drift of ["server-error", "rate-limit"] as const) expect((await f(drift, x.commands.invoiceList, {})).kind).toBe("network");
        expect((await run(x.commands.subscriptionShow, {})).customer).toBe(ACCOUNT.name);
      }, 120_000);

      if (auth === "login") {
        test("a revoked bearer or an ended session is refreshed headless from the profile, and the command succeeds", async () => {
          site.revokeTokens();
          expect((await run(x.commands.subscriptionShow, {})).customer).toBe(ACCOUNT.name);
          site.revokeSessions();
          // The REST read is redirected to the login host first; GraphQL answers 401.
          const c = client();
          const session = await c.ensureSession();
          const out = await x.commands.invoiceShow.run({ id: INVOICES[0]!.id }, { call: c.call, session, note: () => {} });
          expect(out.id).toBe(INVOICES[0]!.id);
        }, 60_000);

        test("when sign-in cannot complete, the command fails with session", async () => {
          // A short wait for the (headless, under SITE_CLI_TEST) "headed" sign-in instead of 10 minutes.
          const impatient = { ...x.site, login: { ...x.site.login, timeoutMs: 2_000 } };
          const c = new rt.Client(impatient, {
            fetch: (u: string, i: RequestInit) => fetch(u, i),
            env,
            login: (headless: boolean) => rt.chromeLogin(impatient, { headless, env }),
            sleep: async () => {},
            retryDelays: [0],
            note: () => {},
          });
          site.revokeSessions();
          site.blockSignIn(true);
          try {
            const session = await c.ensureSession();
            const e = await failure(x.commands.subscriptionShow.run({ all: false }, { call: c.call, session, note: () => {} }));
            expect(e.kind).toBe("session");
          } finally {
            site.blockSignIn(false);
          }
          expect((await run(x.commands.subscriptionShow, {})).customer).toBe(ACCOUNT.name);
        }, 60_000);
      } else {
        test("a stale CSRF token is replaced by rerunning bootstrap", async () => {
          writeFileSync(
            join(env.SITE_CLI_HOME!, "session.json"),
            JSON.stringify({ headers: { cookie: "csrf_token=stale", "x-csrf-token": "stale" }, ids: {}, savedAt: new Date().toISOString() }),
          );
          expect((await run(x.commands.subscriptionShow, {})).customer).toBe(ACCOUNT.name);
          expect(readFileSync(join(env.SITE_CLI_HOME!, "session.json"), "utf8")).not.toContain("stale");
        }, 60_000);
      }

      test("check passes, and check --writes intercepts addNote without writing", async () => {
        const ops = Object.values(x.ops);
        const plain = await rt.check(client(), ops, {});
        expect(plain.operations.map((r: any) => `${r.operation}:${r.status}`).sort()).toEqual(
          [`${OPERATION_NAMES.getInvoice}:ok`, `${OPERATION_NAMES.listInvoices}:ok`, "addNote:skipped", "getAccount:ok", "listSubscriptions:ok"].sort(),
        );
        const before = site.notes().length;
        const writes = await rt.check(client(), ops, { writes: true });
        expect(writes.operations.find((r: any) => r.operation === "addNote").status).toBe("ok");
        expect(site.notes().length).toBe(before);
      }, 60_000);

      test("check reports every drifted read, and --writes catches a changed write shape and a changed UI", async () => {
        const ops = Object.values(x.ops);
        const reads = await withDrift("rename-field", () => failure(rt.check(client(), ops, {})));
        expect(reads.kind).toBe("drift");
        expect(reads.drifts!.map((d) => d.fingerprint)).toEqual([`${prefix}listSubscriptions:zod:data.listSubscriptions[].status:invalid_type`]);
        const before = site.notes().length;
        const shape = await withDrift("write-shape", () => failure(rt.check(client(), ops, { op: "addNote" })));
        expect(shape.drifts!.map((d) => d.fingerprint)).toEqual([`${prefix}addNote:request:text:invalid_type`]);
        const ui = await withDrift("ui-change", () => failure(rt.check(client(), ops, { op: "addNote" })));
        expect(ui.kind).toBe("drift");
        expect(ui.drifts!.map((d) => d.fingerprint)).toEqual([`${prefix}addNote:trigger:getByLabel('Ny note'):TimeoutError`]);
        expect(site.notes().length).toBe(before);
        valueFree(shape);
      }, 90_000);
    });
  }
});

// ---- the frontend in Chrome --------------------------------------------------

describe.skipIf(!HAS_CHROME)("frontend in headless Chrome", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
  });
  afterAll(() => browser?.close());

  const open = async (site: FixtureSite) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(site.auth === "login" ? `${site.loginUrl}/login?autologin=1` : `${site.url}/`);
    await page.waitForSelector("body[data-state=loaded]", { timeout: 10_000 });
    return { context, page };
  };

  for (const auth of ["none", "login"] as const) {
    test(`loads account data and adds a note through the mutation (auth ${auth})`, async () => {
      const site = startFixtureSite({ auth });
      try {
        const { context, page } = await open(site);
        expect(page.url()).toBe(`${site.url}/`);
        expect(await page.textContent("#account-name")).toBe(ACCOUNT.name);
        expect(await page.locator("#subscriptions tr").count()).toBe(4);
        expect(await page.locator("#invoices li").count()).toBe(INVOICES.length);

        const ops = site.requests().filter((r) => r.operationName).map((r) => r.operationName);
        expect(ops).toEqual(["getAccount", "listSubscriptions"]);
        const paths = site.requests().map((r) => r.path).filter((p) => p !== "/favicon.ico");
        expect(paths).toContain("/api/invoices");
        expect(paths).toContain(`/api/invoices/${INVOICES[0]!.id}`);
        if (auth === "login") {
          expect(site.requests()[0]!.host).toBe(new URL(site.loginUrl).host);
          expect(paths.slice(0, 5)).toEqual(["/login", "/auth/callback", "/", "/oauth/token", "/api/session/post-login"]);
        }

        await page.getByLabel("Ny note").fill("Ring efter kl. 17");
        const [request] = await Promise.all([
          page.waitForRequest((r) => r.url().endsWith("/graphql") && r.postDataJSON()?.operationName === "addNote"),
          page.getByRole("button", { name: "Tilføj note" }).click(),
        ]);
        expect(request.postDataJSON().variables).toEqual({ accountId: ACCOUNT.id, text: "Ring efter kl. 17" });
        await page.waitForSelector("#notes li:has-text('Ring efter kl. 17')");
        expect(site.notes().at(-1)!.text).toBe("Ring efter kl. 17");
        await context.close();
      } finally {
        site.stop();
      }
    }, 30_000);

    if (auth === "login") {
      test("later page loads reuse the cached token; a revoked one is replaced by signing in again", async () => {
        const site = startFixtureSite({ auth });
        try {
          const { context, page } = await open(site);
          const tokenRequests = () => site.requests().filter((r) => r.path === "/oauth/token" || r.path === "/api/session/post-login").length;
          expect(tokenRequests()).toBe(2);
          await page.reload();
          await page.waitForSelector("body[data-state=loaded]", { timeout: 10_000 });
          expect(tokenRequests()).toBe(2);
          site.revokeTokens();
          await page.reload();
          await page.waitForSelector("body[data-state=loaded]", { timeout: 10_000 });
          expect(tokenRequests()).toBe(4);
          // A new sign-in starts a new login session, so the cached token is not reused.
          await page.goto(`${site.loginUrl}/login?autologin=1`);
          await page.waitForSelector("body[data-state=loaded]", { timeout: 10_000 });
          expect(tokenRequests()).toBe(6);
          await context.close();
        } finally {
          site.stop();
        }
      }, 30_000);
    }

    test(`the expected addNote trigger reaches the write, which can be intercepted (auth ${auth})`, async () => {
      const site = startFixtureSite({ auth });
      const x = await loadExpected(auth, site.url);
      try {
        // check --writes runs triggers with relative URLs resolved against the site origin.
        const context = await browser.newContext({ baseURL: site.url });
        const page = await context.newPage();
        if (auth === "login") await page.goto(`${site.loginUrl}/login?autologin=1`);
        const seen: unknown[] = [];
        await page.route("**/graphql", async (route) => {
          const body = route.request().postDataJSON();
          if (body?.operationName !== "addNote") return route.continue();
          seen.push(body);
          await route.abort();
        });
        const before = site.notes().length;
        await x.ops.addNote.trigger(page);
        for (const end = Date.now() + 10_000; seen.length === 0 && Date.now() < end; ) await Bun.sleep(50);
        expect(seen.length).toBe(1);
        expect(Object.keys((seen[0] as any).variables).sort()).toEqual(["accountId", "text"]);
        expect(() => x.ops.addNote.variables.parse((seen[0] as any).variables)).not.toThrow();
        expect(site.notes().length).toBe(before);
        await context.close();
      } finally {
        site.stop();
        rmSync(x.dir, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test("write-shape: the frontend sends the note as `body`, which the Contract's variables reject", async () => {
    const site = startFixtureSite({ auth: "none" });
    site.setDrift("write-shape");
    const x = await loadExpected("none", site.url);
    try {
      const { context, page } = await open(site);
      await page.getByLabel("Ny note").fill("ny form");
      const [request] = await Promise.all([
        page.waitForRequest((r) => r.url().endsWith("/graphql") && r.postDataJSON()?.operationName === "addNote"),
        page.getByRole("button", { name: "Tilføj note" }).click(),
      ]);
      const variables = request.postDataJSON().variables;
      expect(Object.keys(variables).sort()).toEqual(["accountId", "body"]);
      const parsed = x.ops.addNote.variables.safeParse(variables);
      expect(parsed.success).toBe(false);
      expect(parsed.error!.issues.map((i: any) => `${i.path.join(".")}:${i.code}`)).toEqual(["text:invalid_type"]);
      await page.waitForSelector("#notes li:has-text('ny form')");
      await context.close();
    } finally {
      site.stop();
      rmSync(x.dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("ui-change: the old trigger no longer finds the note form", async () => {
    const site = startFixtureSite({ auth: "none" });
    site.setDrift("ui-change");
    const x = await loadExpected("none", site.url);
    try {
      const context = await browser.newContext({ baseURL: site.url });
      context.setDefaultTimeout(1_500);
      const page = await context.newPage();
      const error = await x.ops.addNote.trigger(page).then(() => null, (e: Error) => e);
      expect(error?.name).toBe("TimeoutError");
      expect(await page.getByLabel("Skriv en besked").count()).toBe(1);
      await context.close();
    } finally {
      site.stop();
      rmSync(x.dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("the frontend shows an error instead of data when the site rejects it", async () => {
    const site = startFixtureSite({ auth: "none" });
    site.setDrift("server-error");
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${site.url}/`);
      await page.waitForSelector("body[data-state=error]", { timeout: 10_000 });
      expect(await page.locator("#subscriptions tr").count()).toBe(0);
      await context.close();
    } finally {
      site.stop();
    }
  }, 30_000);
});
