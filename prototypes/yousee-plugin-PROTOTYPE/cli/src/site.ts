// GENERATED CONFIG — written once by the generator from the Capture. PROTOTYPE.
export const site = {
  plugin: "yousee",
  version: "0.1.0",
  repo: "<owner>/yousee-plugin",               // where `report` files Drift
  origin: "https://yousee.dk",
  graphql: "/shop/api/graphql-server/graphql",
  loginUrl: "https://yousee.dk/mit-yousee",
  loginHosts: [/login\.yousee\.dk/],           // redirect here = session kind
  // Which request carries the bearer the CLI caches after login.
  tokenRequest: (url: string) => url.includes("/shop/api/graphql-server/graphql"),
};
