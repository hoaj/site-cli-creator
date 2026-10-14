// A CLI entry like main.ts, wired to the test Contracts, for process-level tests. Under
// SITE_CLI_TEST=1 it talks to SITE_CLI_ORIGIN instead of the fake site's origin.
import { z } from "zod";
import { run } from "../../src/main";
import { defineCommand } from "../../src/runtime/command";
import { emit } from "../../src/runtime/envelope";
import { crashCommand, getCustomer, getOrder, listProducts, makeSite, orderRename, productsShow, renameOrder } from "../helpers";

/** A result far above the 64 KB a pipe takes in one write. */
const bigList = defineCommand({
  name: "big list",
  summary: "Returns a large result",
  args: z.object({ rows: z.number().int() }),
  uses: [],
  run: async ({ rows }) => Array.from({ length: rows }, (_, i) => ({ i, pad: "x".repeat(40) })),
});

const { output, code } = await run(process.argv.slice(2), {
  site: makeSite(),
  operations: [getCustomer, listProducts, getOrder, renameOrder],
  commands: [productsShow, orderRename, crashCommand, bigList],
  deps: { retryDelays: [0] },
});
await emit(output, code);
