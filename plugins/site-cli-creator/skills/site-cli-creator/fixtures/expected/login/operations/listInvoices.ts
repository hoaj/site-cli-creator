// From captures/invoice-list/GET-api-invoices.shape.json.
import { z } from "zod";
import { defineOperation } from "../runtime/operation";

export default defineOperation({
  name: "GET /api/invoices",
  effect: "read",
  rest: { method: "GET", path: "/api/invoices", query: (v) => ({ accountId: v.accountId }) },
  variables: z.object({ accountId: z.string().min(1) }),
  response: z.object({
    invoices: z.array(
      z.object({
        id: z.string(),
        number: z.string(),
        issuedAt: z.string(),
        dueDate: z.string().nullable(),
        amountDKK: z.number(),
        status: z.string(),
      }),
    ),
  }),
  needs: { accountId: { from: "getAccount", pick: (r) => r.data.getAccount.id } },
});
