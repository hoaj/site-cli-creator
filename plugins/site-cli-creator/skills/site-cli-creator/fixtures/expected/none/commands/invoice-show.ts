import { z } from "zod";
import { defineCommand } from "../runtime/command";
import getInvoice from "../operations/getInvoice";

export default defineCommand({
  name: "invoice show",
  summary: "One invoice with its lines",
  args: z.object({ id: z.string().min(1).describe("invoice id, as listed by `invoice list`") }),
  uses: [getInvoice],
  run: async ({ id }, { call }) => {
    const invoice = await call(getInvoice, { id });
    return {
      id: invoice.id,
      number: invoice.number,
      issued: invoice.issuedAt,
      due: invoice.dueDate,
      amountDKK: invoice.amountDKK,
      status: invoice.status,
      lines: invoice.lines,
    };
  },
});
