// FIXED TEMPLATE FILE — copied verbatim into every generated plugin. PROTOTYPE.
// One exit code per failure kind (from "Drift classification vs other failures").
// stdout is always exactly one JSON document; stderr is progress chrome.

export type Kind = "drift" | "session" | "network" | "input";
export const EXIT: Record<Kind | "ok" | "bug", number> = {
  ok: 0, bug: 1, input: 2, drift: 3, session: 4, network: 5,
};

export class Failure extends Error {
  constructor(
    public kind: Kind,
    message: string,
    public fingerprint?: string, // drift only: plugin:operation:breakType:path
    public diff?: unknown,       // drift only: contract diff, never values
  ) { super(message); }
}

export const note = (msg: string) => process.stderr.write(`· ${msg}\n`);

export function emit(data: unknown): never {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  process.exit(EXIT.ok);
}

export function emitFailure(f: Failure, next?: string): never {
  const error = { kind: f.kind, message: f.message, fingerprint: f.fingerprint, diff: f.diff, next };
  process.stdout.write(JSON.stringify({ error }, null, 2) + "\n");
  process.exit(EXIT[f.kind]);
}
