// From captures/subscription-show/getAccount.shape.json. Without a login the
// shop serves its demo account, so the query takes no variables.
import { z } from "zod";
import { defineOperation } from "../runtime/operation";

export default defineOperation({
  name: "getAccount",
  effect: "read",
  graphql: `query getAccount {
  getAccount { id name email }
}`,
  variables: z.object({}),
  response: z.object({
    data: z.object({
      getAccount: z.object({ id: z.string(), name: z.string(), email: z.string().nullable() }),
    }),
  }),
});
