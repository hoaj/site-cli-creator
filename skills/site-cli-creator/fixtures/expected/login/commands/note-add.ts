import { z } from "zod";
import { defineCommand } from "../runtime/command";
import addNote from "../operations/addNote";
import getAccount from "../operations/getAccount";

export default defineCommand({
  name: "note add",
  summary: "Add a note to your account",
  args: z.object({ text: z.string().min(1).max(500).describe("the note, 1-500 characters") }),
  uses: [getAccount, addNote],
  run: async ({ text }, { call, session }) => {
    const account = (await call(getAccount, { customerId: session.ids.customerId })).data.getAccount;
    const { addNote: note } = (await call(addNote, { accountId: account.id, text })).data;
    return { note };
  },
});
