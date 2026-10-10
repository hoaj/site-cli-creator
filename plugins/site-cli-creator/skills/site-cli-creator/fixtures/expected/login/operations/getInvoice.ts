// From captures/invoice-show/GET-api-invoices-id.shape.json.
import { z } from "zod";
import { defineOperation } from "../runtime/operation";

export default defineOperation({
  name: "GET /api/invoices/:id",
  effect: "read",
  rest: { method: "GET", path: "/api/invoices/:id" },
  variables: z.object({ id: z.string().min(1) }),
  response: z.object({
    id: z.string(),
    number: z.string(),
    issuedAt: z.string(),
    dueDate: z.string().nullable(),
    amountDKK: z.number(),
    status: z.string(),
    lines: z.array(z.object({ text: z.string(), amountDKK: z.number() })),
  }),
  needs: { id: { from: "GET /api/invoices", pick: (r) => r.invoices[0]?.id } },
});
