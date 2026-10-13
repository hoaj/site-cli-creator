import { z } from "zod";
import { defineCommand } from "../runtime/command";
import searchSuppliers from "../operations/searchSuppliers";
import { toDeal } from "../lib/deals";

export default defineCommand({
  name: "deal search",
  summary: "Find LogBuy deals for a product or shop, best match first",
  args: z.object({
    query: z.string().min(1).describe("what to look for, e.g. a product, brand or shop"),
    limit: z.coerce.number().int().min(1).max(200).default(10).describe("how many deals (default 10)"),
  }),
  uses: [searchSuppliers],
  run: async ({ query, limit }, { call }) => {
    const r = await call(searchSuppliers, { query, limit, sortBy: "BestMatch" });
    return { total: r.results.raw.totalResults, deals: r.results.items.map(toDeal) };
  },
});
