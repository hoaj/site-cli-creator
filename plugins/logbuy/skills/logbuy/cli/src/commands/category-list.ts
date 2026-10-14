import { z } from "zod";
import { defineCommand } from "../runtime/command";
import searchSuppliers from "../operations/searchSuppliers";

export default defineCommand({
  name: "category list",
  summary: "The LogBuy deal categories with how many deals each has",
  args: z.object({}),
  uses: [searchSuppliers],
  run: async (_args, { call }) => {
    const r = await call(searchSuppliers, { limit: 1, sortBy: "BestMatch" });
    return { categories: r.availableFilters.categories.map((c) => ({ name: c.name, deals: c.count })) };
  },
});
