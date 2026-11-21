import { z } from "zod";
import { defineCommand } from "../runtime/command";
import getAccount from "../operations/getAccount";
import listSubscriptions from "../operations/listSubscriptions";

export default defineCommand({
  name: "subscription show",
  summary: "Your subscriptions with monthly price (active ones unless --all)",
  args: z.object({ all: z.boolean().default(false).describe("include terminated and pending subscriptions") }),
  uses: [getAccount, listSubscriptions],
  output: z.object({
    customer: z.string().min(1),
    subscriptions: z.array(z.object({ name: z.string(), status: z.string(), since: z.string().nullable(), monthlyDKK: z.number().nullable() })),
    monthlyTotalDKK: z.number(),
  }),
  run: async ({ all }, { call, session }) => {
    const account = (await call(getAccount, { customerId: session.ids.customerId })).data.getAccount;
    const subscriptions = (await call(listSubscriptions, { accountId: account.id })).data.listSubscriptions
      .filter((s) => all || s.status === "active")
      .map((s) => ({ name: s.name, status: s.status, since: s.startDate, monthlyDKK: s.price }));
    return {
      customer: account.name,
      subscriptions,
      monthlyTotalDKK: subscriptions.reduce((sum, s) => sum + (s.monthlyDKK ?? 0), 0),
    };
  },
});
