// AGENT-WRITTEN. PROTOTYPE. Fires on read-only product pages; marked write until
// clarified (see "Contract format per endpoint"). No task command uses it yet —
// it exists so `check` watches it and so the write shape is visible.
import { z } from "zod";
import { defineOperation } from "../runtime/operation";

export default defineOperation({
  name: "createQuote",
  effect: "write",
  graphql: `mutation createQuote($input: QuoteInput!) { createQuote(input: $input) { id } }`,
  variables: z.object({ input: z.object({ customerId: z.string() }).passthrough() }),
  response: z.object({ data: z.object({ createQuote: z.object({ id: z.string() }) }) }),
  trigger: async (page) => {
    await page.goto("https://yousee.dk/ecare/products");
    await page.getByRole("link", { name: /bredbånd|tv|mobil/i }).first().click();
  },
});
