// Site config for the fixture shop with auth login, as the agent leaves it
// after add-skill. Placeholders (__ORIGIN__ etc.) are filled in when the
// fixture is copied into a generated skill, the way add-skill fills them;
// __LOGIN_ORIGIN__ and __LOGIN_HOST__ name the shop's separate sign-in host.
import { z } from "zod";
import { defineSite } from "./runtime/site";

const postLoginResponse = z.object({ personalInfo: z.object({ customerId: z.string().min(1) }) });
// The sign-in's token exchange (POST /oauth/token): the frontend sends its client id, the answer
// carries a refresh token that works once.
const tokenRequest = z.object({ client_id: z.string().min(1) });
const tokenResponse = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1) });
const renewResponse = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional() });

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
    // Run with --anonymous, the site serves a signed-out REST read as an anonymous user (no
    // invoices, 404 on one) instead of refusing it; GET /api/me answers 401 then, so the CLI asks it.
    sessionProbe: "/api/me",
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
    refresh: {
      from: "/oauth/token",
      keep: ({ request, response }) => ({
        clientId: tokenRequest.parse(request).client_id,
        refreshToken: tokenResponse.parse(response).refresh_token,
      }),
      renew: async (ctx) => {
        const res = await ctx.fetch(`${ctx.origin}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: ctx.refresh.refreshToken ?? "", client_id: ctx.refresh.clientId ?? "" }).toString(),
        });
        if (res.status === 400 || res.status === 401) return null; // spent or revoked: sign in with Chrome
        if (!res.ok) throw new Error(`token endpoint answered HTTP ${res.status}`); // tried again
        // A renewal's answer may leave refresh_token out (no rotation): the old one stays then.
        const t = renewResponse.parse(await res.json());
        return {
          headers: { ...ctx.headers, authorization: `Bearer ${t.access_token}` },
          ...(t.refresh_token && { refresh: { ...ctx.refresh, refreshToken: t.refresh_token } }),
        };
      },
    },
  },
});
