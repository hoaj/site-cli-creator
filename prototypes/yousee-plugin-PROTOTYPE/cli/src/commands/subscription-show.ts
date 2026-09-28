// AGENT-WRITTEN task command. PROTOTYPE.
// Composes Operations and returns a small, agent-shaped result (not the raw site JSON).
import { z } from "zod";
import { defineCommand } from "../runtime/command";
import { loadSession } from "../runtime/session";
import getCustomer from "../operations/getCustomer";
import listFtpdProducts from "../operations/listFtpdProducts";

export default defineCommand({
  name: "subscription show",
  summary: "Your active YouSee products with monthly price",
  args: z.object({ all: z.boolean().default(false).describe("include terminated products") }),
  uses: [getCustomer, listFtpdProducts],
  run: async ({ all }, call) => {
    const { customerId } = await loadSession();
    const c = (await call(getCustomer, { customerId })).data.getCustomer;
    const products = (await call(listFtpdProducts, { customerId: c.id })).data.listFtpdProducts
      .filter((p) => all || p.status === "active")
      .map((p) => ({
        name: p.name,
        status: p.status,
        since: p.startDate,
        monthlyDKK: p.productPrice?.find((x) => x.priceType === "recurring")?.price.valueIncludingTaxRounded ?? null,
      }));
    return { customer: c.name, products, monthlyTotalDKK: products.reduce((s, p) => s + (p.monthlyDKK ?? 0), 0) };
  },
});
