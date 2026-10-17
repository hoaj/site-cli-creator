// Every tool prints exactly one JSON document on stdout. Failures print
// {"error": {"message"}} and exit 1; progress goes to stderr.

/** An expected failure whose message is safe and useful to show as-is. */
export class ToolError extends Error {
  override name = "ToolError";
  constructor(
    message: string,
    /** Extra fields for the error JSON, such as the unmet requirements. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** --help: not a failure. runTool prints the value and exits 0. */
export class ToolHelp {
  constructor(readonly value: unknown) {}
}

export function fail(message: string, details?: Record<string, unknown>): never {
  throw new ToolError(message, details);
}

export function progress(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** The first line of an error message or a command's stderr (leading blank lines skipped), for one-line notes. */
export const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Runs a tool's main function and turns its result or failure into the JSON contract. */
export async function runTool(main: () => Promise<unknown>): Promise<never> {
  try {
    printJson(await main());
    process.exit(0);
  } catch (error) {
    if (error instanceof ToolHelp) {
      printJson(error.value);
      process.exit(0);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof ToolError) && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    printJson({ error: { message, ...(error instanceof ToolError ? error.details : {}) } });
    process.exit(1);
  }
}
