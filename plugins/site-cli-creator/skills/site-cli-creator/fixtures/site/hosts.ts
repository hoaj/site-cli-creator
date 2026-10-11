// The fixture's sign-in pages live on a second host name of the same server
// (localhost instead of 127.0.0.1), the way a real site hands sign-in to an SSO
// host. So `site.login.hosts` names a host the site's own pages and APIs never
// live on, and a redirect there unambiguously means "signed out".

export function loginOriginFor(siteUrl: string): string {
  const url = new URL(siteUrl);
  if (url.hostname !== "127.0.0.1") throw new Error(`the fixture site runs on 127.0.0.1, not ${url.hostname}`);
  return `http://localhost:${url.port}`;
}
