// login.paths and login.signedOutSelector (SPEC §7, #107): a site that signs a session out with a redirect to its own
// sign-in page, or with a 200 that renders the sign-in form in place, is signed out, not Drift.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { Client } from "../src/runtime/call";
import { Failure } from "../src/runtime/envelope";
import { defineOperation } from "../src/runtime/operation";
import { saveSession } from "../src/runtime/session";
import { isLoginPath, siteProblems } from "../src/runtime/site";
import { client, fakeFetch, getOrder, json, loginSite, makeDeps, ORIGIN, renameOrder, tempHome } from "./helpers";

let home: ReturnType<typeof tempHome>;
beforeEach(() => (home = tempHome()));
afterEach(() => home.cleanup());

const saved = () => saveSession(home.dir, { headers: { authorization: "Bearer old" }, ids: { customerId: "C-1" } });
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const SIGNED_IN = { id: "1", total: 5 };
const withLogin = (login: Record<string, unknown>) => loginSite({ login: { ...loginSite().login!, ...login } });
const signedIn = (r: { headers: Record<string, string> }) => r.headers.authorization === "Bearer new";

async function failure(p: Promise<unknown>): Promise<Failure> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Failure) return e;
    throw e;
  }
  throw new Error("expected a Failure");
}

describe("login.paths: a redirect to the site's own sign-in page", () => {
  const site = () => withLogin({ paths: ["/login"] });
  const run = async (location: string, s = site()) => {
    saved();
    const { fetch, calls } = fakeFetch((r) => (signedIn(r) ? json(SIGNED_IN) : redirect(location)));
    const d = makeDeps(fetch, home.dir, [{ authorization: "Bearer new" }]);
    const out: any = await client(s, d.deps).call(getOrder, { orderId: "1" });
    return { out, calls, loginCalls: d.loginCalls };
  };

  test("a 302 to /login on the origin signs in again, then the call succeeds (no Drift)", async () => {
    const { out, calls, loginCalls } = await run(`${ORIGIN}/login`);
    expect(out.total).toBe(5);
    expect(loginCalls).toEqual([true]);
    expect(calls).toHaveLength(2); // the redirect is not followed to the form
  });

  test("a relative Location, an absolute one, a trailing slash, a query and a fragment all match", async () => {
    for (const location of ["/login", `${ORIGIN}/login`, "/login/", "/login?next=%2Faccount", "/login/?next=x#top"]) {
      home.cleanup();
      home = tempHome();
      const { out, loginCalls } = await run(location);
      expect([location, out.total, loginCalls]).toEqual([location, 5, [true]]);
    }
  });

  test("/login does not match /login-help, /login/x or /account/login", async () => {
    for (const location of ["/login-help", "/login/x", "/account/login", "/Login"]) {
      home.cleanup();
      home = tempHome();
      saved();
      const { fetch, calls } = fakeFetch((r) => (r.url.endsWith(location) ? json(SIGNED_IN) : redirect(location)));
      const d = makeDeps(fetch, home.dir);
      const out: any = await client(site(), d.deps).call(getOrder, { orderId: "1" });
      expect([location, out.total, d.loginCalls]).toEqual([location, 5, []]);
      expect(calls).toHaveLength(2);
    }
  });

  test("a same-origin redirect elsewhere is followed as before", async () => {
    saved();
    const { fetch, calls } = fakeFetch((r) => (new URL(r.url).pathname === "/api/orders/1" ? redirect("/api/v2/orders/1") : json(SIGNED_IN)));
    const d = makeDeps(fetch, home.dir);
    const out: any = await client(site(), d.deps).call(getOrder, { orderId: "1" });
    expect(out.total).toBe(5);
    expect(d.loginCalls).toEqual([]);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/orders/1", "/api/v2/orders/1"]);
  });

  test("a path on another host is not the site's sign-in page", async () => {
    saved();
    const { fetch } = fakeFetch(() => redirect("https://elsewhere.example.test/login"));
    const d = makeDeps(fetch, home.dir);
    const f = await failure(client(site(), d.deps).call(getOrder, { orderId: "1" }));
    expect(d.loginCalls).toEqual([]);
    expect(f.kind).toBe("drift"); // offsite, as today
  });

  test("with no login.paths a same-origin redirect to /login is followed, byte for byte as before", async () => {
    saved();
    const { fetch, calls } = fakeFetch((r) => (r.url.endsWith("/login") ? html("<form id=login></form>") : redirect("/login")));
    const d = makeDeps(fetch, home.dir);
    const f = await failure(client(loginSite(), d.deps).call(getOrder, { orderId: "1" }));
    expect(d.loginCalls).toEqual([]);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/orders/1", "/login"]);
    expect(f.kind).toBe("drift"); // the 200 form is read as the Operation's answer
    expect(f.fingerprint).toContain(":zod:");
  });

  test("still redirected to the sign-in page after the one re-sign-in: session, no loop, no Drift", async () => {
    saved();
    const { fetch, calls } = fakeFetch(() => redirect("/login"));
    const d = makeDeps(fetch, home.dir, [{ authorization: "Bearer new" }, { authorization: "Bearer newer" }]);
    const f = await failure(client(site(), d.deps).call(getOrder, { orderId: "1" }));
    expect(f.kind).toBe("session");
    expect(f.message).toContain("sign-in");
    expect(d.loginCalls).toEqual([true]); // headless once; never a second round
    expect(calls).toHaveLength(2);
  });

  test("a client that may not sign in (MCP, SITE_CLI_NONINTERACTIVE) reports session, not Drift", async () => {
    saved();
    const { fetch } = fakeFetch(() => redirect("/login"));
    const d = makeDeps(fetch, home.dir, [null]);
    const f = await failure(new Client(site(), d.deps, { surface: "mcp" }).call(getOrder, { orderId: "1" }));
    expect(f.kind).toBe("session");
  });

  test("the session probe redirected to a login path is signed out although the page it leads to is a 200", async () => {
    saved();
    const { fetch, calls } = fakeFetch((r) => {
      if (signedIn(r)) return json(SIGNED_IN);
      return r.url.endsWith("/api/me") ? redirect("/login") : r.url.endsWith("/login") ? html("<form id=login></form>") : json({}, 404);
    });
    const d = makeDeps(fetch, home.dir, [{ authorization: "Bearer new" }]);
    const out: any = await client(withLogin({ paths: ["/login"], sessionProbe: "/api/me" }), d.deps).call(getOrder, { orderId: "1" });
    expect(out.total).toBe(5);
    expect(d.loginCalls).toEqual([true]);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/me", "/api/orders/1"]);
  });
});

describe("login.signedOutSelector: a 200 that renders the sign-in form in place", () => {
  const orders = defineOperation({
    name: "GET /orders",
    effect: "read",
    rest: { method: "GET", path: "/orders" },
    variables: z.object({}),
    response: z.object({ rows: z.array(z.object({ t: z.string().nullable() })) }),
    html: { fields: { rows: { each: "li.order", in: "ul.orders", fields: { t: "a" } } } },
  });
  const PAGE = `<!doctype html><html><body><ul class="orders"><li class="order"><a>A-1</a></li></ul></body></html>`;
  const FORM = `<!doctype html><html><body><form id="signin" action="/login"><input name="user"></form></body></html>`;
  const site = () => withLogin({ signedOutSelector: "form#signin" });

  test("a matching HTML 200 signs in again, then the page is read", async () => {
    saved();
    const { fetch, calls } = fakeFetch((r) => html(signedIn(r) ? PAGE : FORM));
    const d = makeDeps(fetch, home.dir, [{ authorization: "Bearer new" }]);
    const out: any = await client(site(), d.deps).call(orders, {});
    expect(out.rows).toEqual([{ t: "A-1" }]);
    expect(d.loginCalls).toEqual([true]);
    expect(calls).toHaveLength(2);
  });

  test("without the selector the same form is html Drift, as before", async () => {
    saved();
    const { fetch } = fakeFetch(() => html(FORM));
    const d = makeDeps(fetch, home.dir);
    const f = await failure(client(loginSite(), d.deps).call(orders, {}));
    expect(f.kind).toBe("drift");
    expect(f.fingerprint).toContain(":html:");
    expect(d.loginCalls).toEqual([]);
  });

  test("a page without the element is read normally, no sign-in", async () => {
    saved();
    const { fetch } = fakeFetch(() => html(PAGE));
    const d = makeDeps(fetch, home.dir);
    const out: any = await client(site(), d.deps).call(orders, {});
    expect(out.rows).toHaveLength(1);
    expect(d.loginCalls).toEqual([]);
  });

  test("a JSON answer is never checked, even when its text holds the selector's element", async () => {
    saved();
    const { fetch } = fakeFetch(() => json({ id: "1", total: 5, note: FORM }));
    const d = makeDeps(fetch, home.dir);
    const out: any = await client(site(), d.deps).call(getOrder, { orderId: "1" });
    expect(out.total).toBe(5);
    expect(d.loginCalls).toEqual([]);
  });

  test("still the form after the one re-sign-in: session, no loop, no Drift", async () => {
    saved();
    const { fetch, calls } = fakeFetch(() => html(FORM));
    const d = makeDeps(fetch, home.dir, [{ authorization: "Bearer new" }, { authorization: "Bearer newer" }]);
    const f = await failure(client(site(), d.deps).call(orders, {}));
    expect(f.kind).toBe("session");
    expect(d.loginCalls).toEqual([true]);
    expect(calls).toHaveLength(2);
  });

  test("an auth none skill ignores the field", async () => {
    const { fetch } = fakeFetch(() => html(FORM));
    const s = { ...site(), auth: "none" as const };
    const f = await failure(client(s, makeDeps(fetch, home.dir).deps).call(orders, {}));
    expect(f.kind).toBe("drift");
  });

  test("the session probe answering the form (HTML) is signed out; a JSON probe answer is not checked", async () => {
    saved();
    const probed = () => withLogin({ signedOutSelector: "form#signin", sessionProbe: "/api/me" });
    const { fetch, calls } = fakeFetch((r) => (r.url.endsWith("/api/me") ? (signedIn(r) ? json({ ok: true }) : html(FORM)) : json(SIGNED_IN)));
    const d = makeDeps(fetch, home.dir, [{ authorization: "Bearer new" }]);
    await client(probed(), d.deps).call(getOrder, { orderId: "1" });
    expect(d.loginCalls).toEqual([true]);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/me", "/api/orders/1"]);

    home.cleanup();
    home = tempHome();
    saved();
    const json2 = fakeFetch((r) => (r.url.endsWith("/api/me") ? json({ form: FORM }) : json(SIGNED_IN)));
    const d2 = makeDeps(json2.fetch, home.dir);
    await client(probed(), d2.deps).call(getOrder, { orderId: "1" });
    expect(d2.loginCalls).toEqual([]);
  });
});

describe("a write is never sent twice (review 1)", () => {
  const FORM = `<!doctype html><html><body><form id="signin"></form></body></html>`;
  const answers: Record<string, () => Response> = {
    "303 to /login": () => redirect("/login", 303),
    "302 to /login": () => redirect("/login", 302),
    "200 sign-in form": () => html(FORM),
  };
  for (const [name, answer] of Object.entries(answers)) {
    test(`${name}: one write request, kind session, no sign-in`, async () => {
      saved();
      const { fetch, calls } = fakeFetch((r) => (r.url.endsWith("/login") ? html(FORM) : answer()));
      const d = makeDeps(fetch, home.dir, [{ authorization: "Bearer new" }]);
      const c = client(withLogin({ paths: ["/login"], signedOutSelector: "form#signin" }), d.deps, true);
      const f = await failure(c.call(renameOrder, { orderId: "7", name: "N" }));
      expect(f.kind).toBe("session");
      expect(f.message).toContain("not sent again");
      expect(calls.filter((x) => x.method === "PATCH")).toHaveLength(1);
      expect(calls).toHaveLength(1);
      expect(d.loginCalls).toEqual([]);
    });
  }
});

describe("a write is never resent, on any answer (review 2)", () => {
  test("a PATCH that gets 401, is renewed, and then gets 303 /login: two requests, no further sign-in", async () => {
    saveSession(home.dir, { headers: { authorization: "Bearer old" }, ids: { customerId: "C-1" }, refresh: { token: "r1" } });
    const s = withLogin({
      paths: ["/login"],
      refresh: { renew: async (ctx: any) => ({ headers: { ...ctx.headers, authorization: "Bearer new" }, refresh: { token: "r2" } }) },
    });
    const { fetch, calls } = fakeFetch((r) => (r.headers.authorization === "Bearer new" ? redirect("/login", 303) : json({}, 401)));
    const d = makeDeps(fetch, home.dir, [{ authorization: "Bearer newer" }]);
    const f = await failure(client(s, d.deps, true).call(renameOrder, { orderId: "7", name: "N" }));
    expect(f.kind).toBe("session");
    expect(f.message).toContain("may have taken effect");
    expect(calls.map((c) => c.method)).toEqual(["PATCH", "PATCH"]);
    expect(d.loginCalls).toEqual([]);
  });
});

describe("path normalization (review 2)", () => {
  const at = (paths: string[], u: string) => isLoginPath(withLogin({ paths }), new URL(u, ORIGIN), ORIGIN);

  test("percent-escape case does not matter, on either side", () => {
    expect([at(["/log-på"], "/log-p%c3%a5"), at(["/log-p%c3%a5"], "/log-p%C3%A5"), at(["/log-p%C3%A5"], "/log-p%c3%a5"), at(["/log-på"], "/log-p%C3%A5")]).toEqual([true, true, true, true]);
  });

  test("a ;parameter on the last segment is ignored, a longer name is not", () => {
    expect([at(["/login"], "/login;jsessionid=A1"), at(["/login"], "/login;x=1/"), at(["/login"], "/login-help;x=1"), at(["/login"], "/a;b=1/login"), at(["/login"], "/login/x;y")]).toEqual([true, true, false, false, false]);
  });
});

describe("encoded paths and content types (review 1)", () => {
  test("an entry with a non-ASCII letter or a space matches the encoded Location", () => {
    const s = withLogin({ paths: ["/log-på", "/sign in"] });
    const at = (u: string) => isLoginPath(s, new URL(u, ORIGIN), ORIGIN);
    expect([at("/log-p%C3%A5"), at("/log-på/"), at("/sign%20in?x=1"), at("/sign+in"), at("/log-pa")]).toEqual([true, true, true, false, false]);
  });

  test("only text/html and application/xhtml+xml answers are checked for the selector", async () => {
    const FORM = `<form id="signin"></form>`;
    const cases: Array<[string | undefined, boolean]> = [
      ["text/html", true],
      ["TEXT/HTML ; charset=utf-8", true],
      ["application/xhtml+xml", true],
      ["application/vnd.site.html+json", false],
      ["text/plain", false],
      [undefined, false],
    ];
    for (const [type, matches] of cases) {
      home.cleanup();
      home = tempHome();
      saved();
      const { fetch } = fakeFetch(() => new Response(FORM, { headers: type ? { "content-type": type } : {} }));
      const d = makeDeps(fetch, home.dir);
      const wrap = defineOperation({
        name: "GET /raw",
        effect: "read",
        rest: { method: "GET", path: "/raw" },
        variables: z.object({}),
        response: z.any(),
      });
      await client(withLogin({ signedOutSelector: "form#signin" }), d.deps).call(wrap, {}).catch(() => {});
      expect([type, d.loginCalls.length > 0]).toEqual([type, matches]);
    }
  });
});

describe("validation", () => {
  const problems = (login: Record<string, unknown>) => siteProblems(withLogin(login));

  test("login.paths: a list of paths on the origin, each with a single leading /", () => {
    expect(problems({ paths: ["/login", "/account/signin/"] })).toEqual([]);
    expect(problems({ paths: [] })).toEqual([]);
    const msg = ["login.paths must be a list of paths on the origin, each starting with a single /"];
    for (const bad of [["login"], ["https://other.example.test/login"], ["//other.example.test/login"], [""], ["/ok", "x"], "/login", [1]]) {
      expect(problems({ paths: bad })).toEqual(msg);
    }
  });

  test("login.signedOutSelector: a non-empty CSS selector the parser reads", () => {
    expect(problems({ signedOutSelector: "form#login, form[action='/login']" })).toEqual([]);
    expect(problems({ signedOutSelector: "" })).toEqual(["login.signedOutSelector must be a non-empty CSS selector"]);
    expect(problems({ signedOutSelector: 5 })).toEqual(["login.signedOutSelector must be a non-empty CSS selector"]);
    expect(problems({ signedOutSelector: "a[" })[0]).toContain("login.signedOutSelector is not a CSS selector the parser reads");
  });

  test("isLoginPath compares the resolved pathname on the origin only", () => {
    const s = withLogin({ paths: ["/login", "/sign-in/?x=1"] });
    const at = (u: string) => isLoginPath(s, new URL(u, ORIGIN), ORIGIN);
    expect([at("/login"), at("/login/"), at("/sign-in?next=/"), at("/login-help"), at("https://other.example.test/login")]).toEqual([true, true, true, false, false]);
    expect(isLoginPath(loginSite(), new URL("/login", ORIGIN), ORIGIN)).toBe(false);
  });
});
