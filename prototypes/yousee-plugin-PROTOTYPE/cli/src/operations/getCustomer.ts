// AGENT-WRITTEN from captures/getCustomer.shape.json. PROTOTYPE.
import { z } from "zod";
import { defineOperation } from "../runtime/operation";

export default defineOperation({
  name: "getCustomer",
  effect: "read",
  graphql: `query getCustomer($customerId: String!) { getCustomer(id: $customerId) { id name customerType } }`,
  variables: z.object({ customerId: z.string() }),
  response: z.object({ data: z.object({ getCustomer: z.object({ id: z.string(), name: z.string(), customerType: z.string().nullable() }) }) }),
  // ASSUMPTION: the chain root comes from the session (JWT claim / post-login body).
  needs: { customerId: { from: "session", pick: (s) => s.customerId } },
});
