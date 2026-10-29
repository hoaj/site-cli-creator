// site.ts helpers: config problems, the test-only origin override, login hosts, JWT claims.
import { describe, expect, test } from "bun:test";
import { chromeMissing, loginTimeoutMs, siteCookie } from "../src/runtime/login";
import { decodeJwt, effectiveOrigin, isLoginHost, rebase, siteProblems, tokenMatches } from "../src/runtime/site";
import { loginSite, makeSite } from "./helpers";

describe("siteProblems", () => {
  test("a filled-in site has none", () => {
    expect(siteProblems(makeSite())).toEqual([]);
    expect(siteProblems(loginSite())).toEqual([]);
  });

  // add-skill replaces the placeholders in this file too; then the unfilled case can't be built here.
  const starterCopy = ("__AUTH__" as string).startsWith("__");
  test.skipIf(!starterCopy)("unfilled placeholders are reported", () => {
    expect(siteProblems(makeSite({ auth: "__AUTH__" as any, origin: "__ORIGIN__" }))).toEqual([
      'auth must be "login" or "none"',
      "origin must be an http(s) URL",
    ]);
  });

  test("a login skill without a login block and a bad readOnlyRequests are reported", () => {
    expect(siteProblems(makeSite({ auth: "login" }))).toEqual(['auth "login" needs a login block']);
    expect(siteProblems(makeSite({ readOnlyRequests: ["/api/token", /\/post-login$/] }))).toEqual([]);
    expect(siteProblems(makeSite({ readOnlyRequests: [""] }))).toEqual(["readOnlyRequests must be a list of non-empty URL path substrings or RegExps"]);
    expect(siteProblems(makeSite({ readOnlyRequests: "/api/token" as any }))).toHaveLength(1);
  });

  test("transport is fetch or browser; browserWindow only with transport browser (#93)", () => {
    expect(siteProblems(makeSite({ transport: "fetch" }))).toEqual([]);
    expect(siteProblems(makeSite({ transport: "browser", browserWindow: true }))).toEqual([]);
    expect(siteProblems(makeSite({ transport: "curl" as any }))).toEqual(['transport must be "fetch" or "browser"']);
    expect(siteProblems(makeSite({ browserWindow: true }))).toEqual(['browserWindow needs transport "browser"']);
  });

  test("login.refresh needs renew, and keep when it names a request to keep from (#94)", () => {
    const renew = async () => null;
    const withRefresh = (refresh: any) => siteProblems(loginSite({ login: { ...loginSite().login!, refresh } }));
    expect(withRefresh({ renew })).toEqual([]);
    expect(withRefresh({ from: "/oauth/token", keep: () => ({}), renew })).toEqual([]);
    expect(withRefresh({ from: "/oauth/token" })).toEqual(["login.refresh needs a renew function", "login.refresh.from needs a keep function"]);
  });

  test("login.sessionProbe must be a path on the origin, so the session never goes to another host", () => {
    const probe = (sessionProbe: string) => siteProblems(loginSite({ login: { ...loginSite().login!, sessionProbe } }));
    expect(probe("/api/me")).toEqual([]);
    for (const bad of ["api/me", "https://other.example.test/api/me", "//other.example.test/api/me", ""]) {
      expect(probe(bad)).toEqual(["login.sessionProbe must be a path on the origin, starting with a single /"]);
    }
  });
});

describe("login timeout", () => {
  const site = loginSite();
  const withTimeout = { ...site, login: { ...site.login!, timeoutMs: 120_000 } };
  const noTimeout = { ...site, login: { ...site.login!, timeoutMs: undefined } };

  test("headed sign-in waits site.login.timeoutMs (10 min by default); the headless refresh at most 30 s", () => {
    expect(loginTimeoutMs(withTimeout, false, {})).toBe(120_000);
    expect(loginTimeoutMs(noTimeout, false, {})).toBe(600_000);
    expect(loginTimeoutMs(withTimeout, true, {})).toBe(30_000);
    expect(loginTimeoutMs(noTimeout, true, {})).toBe(30_000);
  });

  test("SITE_CLI_LOGIN_TIMEOUT_MS replaces it only with SITE_CLI_TEST=1", () => {
    expect(loginTimeoutMs(withTimeout, false, { SITE_CLI_LOGIN_TIMEOUT_MS: "2000" })).toBe(120_000);
    expect(loginTimeoutMs(withTimeout, false, { SITE_CLI_TEST: "1", SITE_CLI_LOGIN_TIMEOUT_MS: "2000" })).toBe(2_000);
    expect(loginTimeoutMs(withTimeout, true, { SITE_CLI_TEST: "1", SITE_CLI_LOGIN_TIMEOUT_MS: "2000" })).toBe(2_000);
    expect(loginTimeoutMs(withTimeout, false, { SITE_CLI_TEST: "1", SITE_CLI_LOGIN_TIMEOUT_MS: "soon" })).toBe(120_000);
  });
});

describe("origin override", () => {
  const site = makeSite({ origin: "https://shop.example.test/" });

  test("SITE_CLI_ORIGIN applies only with SITE_CLI_TEST=1; trailing slashes are dropped", () => {
    expect(effectiveOrigin(site, {})).toBe("https://shop.example.test");
    expect(effectiveOrigin(site, { SITE_CLI_ORIGIN: "http://127.0.0.1:9" })).toBe("https://shop.example.test");
    expect(effectiveOrigin(site, { SITE_CLI_TEST: "1", SITE_CLI_ORIGIN: "http://127.0.0.1:9/" })).toBe("http://127.0.0.1:9");
  });

  test("rebase moves URLs under the site origin only", () => {
    const env = { SITE_CLI_TEST: "1", SITE_CLI_ORIGIN: "http://127.0.0.1:9" };
    expect(rebase("https://shop.example.test/account?x=1", site, env)).toBe("http://127.0.0.1:9/account?x=1");
    expect(rebase("https://shop.example.test", site, env)).toBe("http://127.0.0.1:9");
    expect(rebase("https://shop.example.testing/account", site, env)).toBe("https://shop.example.testing/account");
    expect(rebase("https://login.example.test/", site, env)).toBe("https://login.example.test/");
  });
});

test("login hosts match the host, the host with port, and subdomains", () => {
  const site = loginSite({ login: { startUrl: "https://shop.example.test/", hosts: ["login.example.test", "127.0.0.1:4000"], tokenRequest: "/api/" } });
  expect(isLoginHost(site, "https://login.example.test/authorize")).toBe(true);
  expect(isLoginHost(site, "https://eu.login.example.test/x")).toBe(true);
  expect(isLoginHost(site, "http://127.0.0.1:4000/login")).toBe(true);
  expect(isLoginHost(site, "https://notlogin.example.test/")).toBe(false);
  expect(isLoginHost(site, "not a url")).toBe(false);
  expect(isLoginHost(makeSite(), "https://login.example.test/")).toBe(false);
});

test("tokenRequest is a substring or a RegExp", () => {
  expect(tokenMatches("/api/", "https://x.test/api/me")).toBe(true);
  expect(tokenMatches("/api/", "https://x.test/graphql")).toBe(false);
  expect(tokenMatches(/\/graphql$/, "https://x.test/graphql")).toBe(true);
});

test("decodeJwt reads the claims of a bearer token (base64url, no padding)", () => {
  const claims = { sub: "C-9", name: "ø~?>" };
  const token = `Bearer h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  expect(decodeJwt(token)).toEqual(claims);
  expect(() => decodeJwt("opaque-token")).toThrow("not a JWT");
});

test("missing Chrome: session for a login skill, input for auth none (check --writes)", () => {
  const env = { SITE_CLI_CHROME: "/nowhere/chrome" };
  expect(chromeMissing(loginSite(), env)!.kind).toBe("session");
  const none = chromeMissing(makeSite(), env)!;
  expect(none.kind).toBe("input");
  expect(none.message).toContain("/nowhere/chrome");
  expect(chromeMissing(makeSite(), { SITE_CLI_CHROME: process.execPath })).toBeNull();
});

test("login --from-profile carries over the cookies of every host the site uses: its domain's hosts, login hosts and their subdomains, parent domains (review)", () => {
  const site = loginSite({ origin: "https://www.example.test", login: { startUrl: "https://www.example.test/", hosts: ["login.idp.test", "127.0.0.1:4000"], tokenRequest: "/api/" } });
  for (const domain of ["www.example.test", ".example.test", "example.test", "api.example.test", ".api.example.test", "login.idp.test", ".idp.test", "eu.login.idp.test", "127.0.0.1"]) {
    expect(siteCookie(site, domain, {}), domain).toBe(true);
  }
  for (const domain of ["evil.test", "notexample.test", "example.test.evil.com", "other.idp.test"]) {
    expect(siteCookie(site, domain, {}), domain).toBe(false);
  }
});
