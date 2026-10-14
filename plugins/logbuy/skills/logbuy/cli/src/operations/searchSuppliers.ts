// From captures/deal-search/GET-api-search-suppliers.shape.json (GET /api/search/suppliers).
// The search API behind mylogbuy.com/search: free text (`query`), category filter (`filters`:
// base64 of {"categories":[name]}, the same value the search page puts in its URL), and the
// category list with counts. Only the fields the commands read are in `response`.
import { z } from "zod";
import { defineOperation } from "../runtime/operation";

export default defineOperation({
  name: "GET /api/search/suppliers",
  effect: "read",
  rest: {
    method: "GET",
    path: "/api/search/suppliers",
    query: (v) => ({
      limit: String(v.limit),
      sortBy: v.sortBy,
      ...(v.query ? { query: v.query } : {}),
      ...(v.filters ? { filters: v.filters } : {}),
    }),
  },
  variables: z.object({
    query: z.string().optional(),
    filters: z.string().optional(),
    limit: z.number().int().min(1).max(200),
    sortBy: z.string(),
  }),
  // What `check` calls it with: a plain "best match" listing of one deal.
  needs: { limit: { value: 1 }, sortBy: { value: "BestMatch" } },
  response: z.object({
    results: z.object({
      items: z.array(z.object({
        title: z.string(),
        discount: z.string(),
        description: z.string(),
        about: z.string(),
        supplierId: z.number(),
        specialOffer: z.object({
          punchline: z.string(),
          detail: z.string(),
          discount: z.string(),
          timeLeft: z.string().nullable(),
        }).nullable(),
        discountInfo: z.object({
          minPercent: z.number().nullable(),
          maxPercent: z.number().nullable(),
        }),
        numberOfAddresses: z.number(),
      })),
      raw: z.object({ totalResults: z.number() }),
    }),
    availableFilters: z.object({
      categories: z.array(z.object({ name: z.string(), count: z.number() })),
    }),
  }),
});
