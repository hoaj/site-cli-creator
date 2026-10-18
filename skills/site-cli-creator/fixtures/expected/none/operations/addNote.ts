// From captures/note-add/addNote.shape.json (the user's one real write).
import { z } from "zod";
import { defineOperation } from "../runtime/operation";

export default defineOperation({
  name: "addNote",
  effect: "write",
  graphql: `mutation addNote($accountId: ID!, $text: String!) {
  addNote(accountId: $accountId, text: $text) { id text createdAt }
}`,
  variables: z.object({ accountId: z.string().min(1), text: z.string().min(1).max(500) }),
  response: z.object({
    data: z.object({ addNote: z.object({ id: z.string(), text: z.string(), createdAt: z.string() }) }),
  }),
  needs: { accountId: { from: "getAccount", pick: (r) => r.data.getAccount.id } },
  trigger: async (page) => {
    await page.goto("/");
    await page.getByLabel("Ny note").fill("check");
    await page.getByRole("button", { name: "Tilføj note" }).click();
  },
});
