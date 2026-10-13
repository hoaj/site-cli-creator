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
  const starterCopy = ("login" as string).startsWith("__");
  test.skipIf(!starterCopy)("unfilled placeholders are reported", () => {
    expect(siteProblems(makeSite({ auth: "login" as any, origin: "https://www.mylogbuy.com" }))).toEqual([
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
