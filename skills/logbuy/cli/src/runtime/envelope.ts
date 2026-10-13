// stdout carries exactly one JSON document per run: the command's result, a dry run, or an
// error envelope. Progress goes to stderr. Nothing a site returned may reach an envelope:
// only names, shapes, type names and status codes.

export const EXIT = { ok: 0, bug: 1, input: 2, drift: 3, session: 4, network: 5 } as const;
export type Kind = Exclude<keyof typeof EXIT, "ok">;

/** One field that no longer matches a Contract. `received` is a type name, never a value. */
export type DiffEntry = { path: string; code: string; expected?: string; received?: string };
export type DriftEntry = { operation: string; fingerprint: string; diff: DiffEntry[] };
export type Account = { id: string; label?: string };

export type FailureDetails = {
  fingerprint?: string;
  diff?: DiffEntry[];
  drifts?: DriftEntry[];
  stack?: string[];
  accounts?: Account[];
};

export class Failure extends Error {
  readonly kind: Kind;
  readonly details: FailureDetails;
  constructor(kind: Kind, message: string, details: FailureDetails = {}) {
    super(message);
    this.name = "Failure";
    this.kind = kind;
    this.details = details;
  }
  get fingerprint() { return this.details.fingerprint; }
  get diff() { return this.details.diff; }
  get drifts() { return this.details.drifts; }
}

/**
 * A mistake in the plugin's own code or config (site.ts, a Contract, the registry), found by the
 * runtime. It is a bug, and its message is written by the runtime, so it may go into the envelope.
 */
export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

/** Thrown by `call` for a write Operation without --confirm; main turns it into the dry run. */
export class DryRun {
  constructor(readonly operation: string, readonly variables: unknown) {}
}

export type EnvelopeSite = { plugin: string; skill: string; version: string };

export function nextStep(kind: Kind, site: EnvelopeSite, hasAccounts = false): string {
  const feedback = `${site.plugin}-feedback`;
  switch (kind) {
    case "bug":
      return `Tell the user this is a bug in the ${site.skill} CLI. Offer to file it through the ${feedback} skill, passing this whole envelope, and file it only if the user says yes.`;
    case "input":
      return hasAccounts
        ? `This login has several accounts. Ask the user which one to use, then pass --account <id> on this command and every later one.`
        : `Fix the command or its flags; run \`${site.skill} help\` to see them.`;
    case "drift":
      return `Stop: the site has changed and the ${site.skill} CLI no longer matches it. Do not work around it with raw calls, curl or the browser. Offer to file it through the ${feedback} skill, passing this whole envelope, and file it only if the user says yes.`;
    case "session":
      return `Run \`${site.skill} login\` (Chrome opens and the user signs in), then rerun the command.`;
    case "network":
      return `Tell the user the site isn't responding right now, and stop. Do not retry in a loop.`;
  }
}

/** `<platform>-<arch>` named like the release targets: darwin-arm64, linux-x64, windows-x64. */
export function osName(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform === "win32" ? "windows" : platform}-${arch}`;
}

export function errorEnvelope(f: Failure, site: EnvelopeSite) {
  const d = f.details;
  return {
    error: {
      kind: f.kind,
      message: f.message,
      ...(d.fingerprint !== undefined && { fingerprint: d.fingerprint }),
      ...(d.diff !== undefined && { diff: d.diff }),
      ...(d.drifts !== undefined && { drifts: d.drifts }),
      ...(d.stack !== undefined && { stack: d.stack }),
      ...(d.accounts !== undefined && { accounts: d.accounts }),
      version: site.version,
      os: osName(),
      next: nextStep(f.kind, site, (d.accounts?.length ?? 0) > 0),
    },
  };
}

export function render(doc: unknown): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

/**
 * Writes the run's one stdout document and exits with its code. The write is awaited:
 * process.stdout.write + process.exit cuts piped output at 64 KB. A reader that closed the
 * pipe early (EPIPE) must not turn into a crash.
 */
export async function emit(doc: unknown, code: number = EXIT.ok): Promise<never> {
  try {
    await Bun.write(Bun.stdout, render(doc));
  } catch {}
  process.exit(code);
}

export function note(message: string): void {
  process.stderr.write(`· ${message}\n`);
}
