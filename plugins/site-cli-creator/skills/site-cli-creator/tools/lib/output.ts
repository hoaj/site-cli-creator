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

export function fail(message: string, details?: Record<string, unknown>): never {
  throw new ToolError(message, details);
}

export function progress(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Runs a tool's main function and turns its result or failure into the JSON contract. */
export async function runTool(main: () => Promise<unknown>): Promise<never> {
  try {
    printJson(await main());
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof ToolError) && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    printJson({ error: { message, ...(error instanceof ToolError ? error.details : {}) } });
    process.exit(1);
  }
}
