// From captures/subscription-show/listSubscriptions.shape.json. The frontend
// also asks for currency and features; the CLI reads neither.
import { z } from "zod";
import { defineOperation } from "../runtime/operation";

export default defineOperation({
  name: "listSubscriptions",
  effect: "read",
  graphql: `query listSubscriptions($accountId: ID!) {
  listSubscriptions(accountId: $accountId) { id name status startDate price }
}`,
  variables: z.object({ accountId: z.string().min(1) }),
  response: z.object({
    data: z.object({
      listSubscriptions: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          status: z.string(),
          startDate: z.string().nullable(),
          price: z.number().nullable(),
        }),
      ),
    }),
  }),
  needs: { accountId: { from: "getAccount", pick: (r) => r.data.getAccount.id } },
});
