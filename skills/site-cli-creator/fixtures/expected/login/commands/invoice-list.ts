import { z } from "zod";
import { defineCommand } from "../runtime/command";
import getAccount from "../operations/getAccount";
import listInvoices from "../operations/listInvoices";

export default defineCommand({
  name: "invoice list",
  summary: "Your invoices, newest first, with amount and payment status",
  args: z.object({}),
  uses: [getAccount, listInvoices],
  run: async (_args, { call, session }) => {
    const account = (await call(getAccount, { customerId: session.ids.customerId })).data.getAccount;
    const { invoices } = await call(listInvoices, { accountId: account.id });
    return {
      invoices: invoices.map((i) => ({
        id: i.id,
        number: i.number,
        issued: i.issuedAt,
        due: i.dueDate,
        amountDKK: i.amountDKK,
        status: i.status,
      })),
    };
  },
});
