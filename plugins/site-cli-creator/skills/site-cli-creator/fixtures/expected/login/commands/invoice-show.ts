import { z } from "zod";
import { defineCommand, inputFailure } from "../runtime/command";
import getAccount from "../operations/getAccount";
import getInvoice from "../operations/getInvoice";
import listInvoices from "../operations/listInvoices";

export default defineCommand({
  name: "invoice show",
  summary: "One invoice with its lines",
  args: z.object({ id: z.string().min(1).describe("invoice id, as listed by `invoice list`") }),
  uses: [getAccount, listInvoices, getInvoice],
  run: async ({ id }, { call, session }) => {
    // The id comes from the user: check it against the list first, so a typo is an input error
    // (exit 2) and a 404 from GET /api/invoices/:id stays what it is, Drift.
    const account = (await call(getAccount, { customerId: session.ids.customerId })).data.getAccount;
    const { invoices } = await call(listInvoices, { accountId: account.id });
    if (!invoices.some((i) => i.id === id)) inputFailure("No invoice with that --id: run `invoice list` to see the ids.");
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
