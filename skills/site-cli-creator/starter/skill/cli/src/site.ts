// The site this CLI skill wraps. Written by add-skill, then edited by the agent from the Capture.
// auth "login": keep `login`, delete `bootstrap`. auth "none": keep `bootstrap` only if the
// public API needs a cookie or token first, and delete `login`. Never store personal data.
import { defineSite, type Auth } from "./runtime/site";

export default defineSite({
  plugin: "__PLUGIN__",
  skill: "__SKILL__",
  repo: "__REPO__",
  version: "0.1.0",
  generatedWith: "__GENERATOR_VERSION__",
  origin: "__ORIGIN__",
  graphqlPath: "/graphql",
  auth: "__AUTH__" as Auth,
  needsChrome: false,
  // When the site refuses plain fetch but answers a browser (a 403 or a challenge page where the
  // Capture saw JSON), send every request from a Chrome tab on the site instead. Slower: Chrome
  // starts once per run. browserWindow: true when it also refuses headless Chrome.
  // transport: "browser",
  login: {
    startUrl: "__ORIGIN__/",
    hosts: [],
    tokenRequest: "/api/",
    // When a signed-out request gets 200 or 404 instead of 401/403 (the site serves it as an
    // anonymous user), set this to a GET path that answers 2xx only while signed in, such as
    // /api/me: the CLI asks it once per run, so an expired sign-in is exit 4, not Drift.
    // sessionProbe: "/api/me",
    timeoutMs: 600_000,
    postLogin: async () => ({}),
  },
  bootstrap: async () => ({ headers: {} }),
  // Non-GET requests the pages send that change no data (token refresh, post-login), so
  // check --writes lets them through; every other non-GET is aborted while a trigger runs.
  readOnlyRequests: [],
  accounts: async () => [],
});
