// From captures/subscription-show/getAccount.shape.json. The chain root
// customerId comes from the session (post-login step in site.ts).
import { z } from "zod";
import { defineOperation } from "../runtime/operation";

export default defineOperation({
  name: "getAccount",
  effect: "read",
  graphql: `query getAccount($customerId: ID!) {
  getAccount(customerId: $customerId) { id name email }
}`,
  variables: z.object({ customerId: z.string().min(1) }),
  response: z.object({
    data: z.object({
      getAccount: z.object({ id: z.string(), name: z.string(), email: z.string().nullable() }),
    }),
  }),
  needs: { customerId: { from: "session", key: "customerId" } },
});
