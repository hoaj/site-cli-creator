import { z } from "zod";
import { defineCommand, inputFailure } from "../runtime/command";
import searchSuppliers from "../operations/searchSuppliers";
import { toDeal } from "../lib/deals";

// The search page's own `filters` value: base64 of the selected facet names.
const categoryFilter = (name: string) => Buffer.from(JSON.stringify({ categories: [name] })).toString("base64");

export default defineCommand({
  name: "deal browse",
  summary: "LogBuy deals in one category, best match first",
  args: z.object({
    category: z.string().min(1).describe("a category name, as `category list` shows it"),
    limit: z.coerce.number().int().min(1).max(200).default(10).describe("how many deals (default 10)"),
  }),
  uses: [searchSuppliers],
  run: async ({ category, limit }, { call }) => {
    const all = await call(searchSuppliers, { limit: 1, sortBy: "BestMatch" });
    const want = category.trim().toLowerCase();
    const match = all.availableFilters.categories.find((c) => c.name.trim().toLowerCase() === want);
    if (!match) {
      inputFailure(`No category named "${category}". Categories: ${all.availableFilters.categories.map((c) => c.name).join(", ")}.`);
    }
    const r = await call(searchSuppliers, { filters: categoryFilter(match.name), limit, sortBy: "BestMatch" });
    return { category: match.name, total: r.results.raw.totalResults, deals: r.results.items.map(toDeal) };
  },
});
