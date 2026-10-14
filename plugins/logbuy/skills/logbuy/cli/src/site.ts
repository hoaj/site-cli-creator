// Visma LogBuy (mylogbuy.com): employee-benefit deals behind an email + password login.
// The session is a cookie set by the sign-in page; no bearer token and no chain-root ids:
// the search API needs nothing but the cookie. Never store personal data.
import { defineSite, type Auth } from "./runtime/site";

export default defineSite({
  plugin: "logbuy",
  skill: "logbuy",
  repo: "hoaj/skills",
  version: "0.3.1",
  generatedWith: "0.2.1",
  origin: "https://www.mylogbuy.com",
  auth: "login" as Auth,
  needsChrome: true,
  login: {
    startUrl: "https://www.mylogbuy.com/",
    hosts: [],
    // Sent on every page load once signed in, and refused while signed out.
    tokenRequest: "/api/notifications/unread-count",
    timeoutMs: 600_000,
    postLogin: async () => ({}),
  },
  readOnlyRequests: [],
  accounts: async () => [],
});
