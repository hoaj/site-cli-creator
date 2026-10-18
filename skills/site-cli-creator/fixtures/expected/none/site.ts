// Site config for the fixture shop with auth none, as the agent leaves it
// after add-skill. Placeholders (__ORIGIN__ etc.) are filled in when the
// fixture is copied into a generated skill, the way add-skill fills them.
import { defineSite } from "./runtime/site";

const CSRF_COOKIE = "csrf_token";

export default defineSite({
  plugin: "__PLUGIN__",
  skill: "__SKILL__",
  repo: "__REPO__",
  version: "0.1.0",
  generatedWith: "__GENERATOR_VERSION__",
  origin: "__ORIGIN__",
  graphqlPath: "/graphql",
  auth: "none",
  needsChrome: true,
  // The front page sets a csrf_token cookie; every API call must send it back
  // both as the cookie and in the x-csrf-token header.
  bootstrap: async (ctx) => {
    const res = await ctx.fetch(`${ctx.origin}/`, { redirect: "manual" });
    if (!res.ok) throw new Error(`front page answered HTTP ${res.status}`);
    const token = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .find((c) => c.startsWith(`${CSRF_COOKIE}=`))
      ?.slice(CSRF_COOKIE.length + 1);
    if (!token) throw new Error(`front page set no ${CSRF_COOKIE} cookie`);
    return { headers: { "x-csrf-token": decodeURIComponent(token), cookie: `${CSRF_COOKIE}=${token}` } };
  },
});
