// The shape every src/commands/<noun>-<verb>.ts exports: one Task as one command.
import type { z } from "zod";
import { Failure } from "./envelope";
import type { Operation } from "./operation";

/** Performs one Operation: validates variables, sends, classifies, returns the parsed response. */
export type Call = <O extends Operation>(op: O, vars: z.input<O["variables"]>) => Promise<z.output<O["response"]>>;

export type CommandCtx = {
  call: Call;
  /** Chain-root ids saved at login (or by bootstrap). */
  session: { readonly ids: Record<string, string> };
  /** The --account value, or the only account when the login has exactly one. */
  account?: string;
  /** Progress line on stderr. */
  note(message: string): void;
};

export type Command<A extends z.ZodObject = z.ZodObject> = {
  /** "<noun> <verb>", in English. */
  name: string;
  summary: string;
  /** Flags (kebab-case on the command line, camelCase keys here). Booleans are presence flags. */
  args: A;
  uses: Operation[];
  run(args: z.output<A>, ctx: CommandCtx): Promise<unknown>;
};

export const defineCommand = <A extends z.ZodObject>(command: Command<A>): Command<A> => command;

/**
 * Ends the command with exit 2 (input): the user's flags are wrong, not the site. Use it when a
 * value the user gave does not exist, e.g. an id that is not in the list Operation's result, so a
 * typo never reaches the site and never looks like Drift. The message is shown to the agent:
 * name the flag and the command that lists valid values, never echo site data.
 */
export function inputFailure(message: string): never {
  throw new Failure("input", message);
}
