// What the gh-driven scripts (fixed-in.ts, stale-prs.ts) share: the command runner and --flag lookup.

export type Run = (cmd: string[]) => Promise<string>;

/** Runs a command and returns its stdout; a non-zero exit throws with its stderr. */
export const spawn: Run = async (cmd) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed (${code}): ${err.trim()}`);
  return out;
};

export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
