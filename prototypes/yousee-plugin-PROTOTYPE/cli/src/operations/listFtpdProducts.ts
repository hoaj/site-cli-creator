// AGENT-WRITTEN from captures/listFtpdProducts.shape.json. PROTOTYPE.
// The frontend's query is ~400 lines of fragments; the CLI sends only what it reads.
import { z } from "zod";
import { defineOperation } from "../runtime/operation";

export default defineOperation({
  name: "listFtpdProducts",
  effect: "read",
  graphql: `query listFtpdProducts($customerId: ID!) {
  listFtpdProducts(customerId: $customerId) {
    id name status startDate
    productPrice { priceType price { valueIncludingTaxRounded } }
  }
}`,
  variables: z.object({ customerId: z.string() }),
  response: z.object({ data: z.object({ listFtpdProducts: z.array(z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    startDate: z.string().nullable(),
    productPrice: z.array(z.object({
      priceType: z.string(),
      price: z.object({ valueIncludingTaxRounded: z.number().nullable() }),
    })).nullable(),
  })) }) }),
  needs: { customerId: { from: "getCustomer", pick: (r) => r.data.getCustomer.id } },
});
