// Site config for the fixture shop with auth login, as the agent leaves it
// after add-skill. Placeholders (__ORIGIN__ etc.) are filled in when the
// fixture is copied into a generated skill, the way add-skill fills them;
// __LOGIN_ORIGIN__ and __LOGIN_HOST__ name the shop's separate sign-in host.
import { z } from "zod";
import { defineSite } from "./runtime/site";

const postLoginResponse = z.object({ personalInfo: z.object({ customerId: z.string().min(1) }) });

export default defineSite({
  plugin: "__PLUGIN__",
  skill: "__SKILL__",
  repo: "__REPO__",
  version: "0.1.0",
  generatedWith: "__GENERATOR_VERSION__",
  origin: "__ORIGIN__",
  graphqlPath: "/graphql",
  auth: "login",
  needsChrome: true,
  login: {
    startUrl: "__LOGIN_ORIGIN__/login?autologin=1",
    hosts: ["__LOGIN_HOST__"],
    tokenRequest: "/graphql",
    timeoutMs: 600_000,
    postLogin: async (ctx) => {
      const token = (ctx.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const claims = ctx.decodeJwt(token) as { account_ref?: unknown; person_ref?: unknown };
      if (typeof claims.account_ref !== "string" || typeof claims.person_ref !== "string")
        throw new Error("access token has no account_ref/person_ref claims");
      const res = await ctx.fetch(`${ctx.origin}/api/session/post-login`, {
        method: "POST",
        headers: { ...ctx.headers, "content-type": "application/json" },
        body: JSON.stringify({ accountRef: claims.account_ref, personRef: claims.person_ref }),
      });
      if (!res.ok) throw new Error(`post-login answered HTTP ${res.status}`);
      // The response also carries CPR and email; only the chain root is kept.
      const { personalInfo } = postLoginResponse.parse(await res.json());
      return { customerId: personalInfo.customerId };
    },
  },
});
