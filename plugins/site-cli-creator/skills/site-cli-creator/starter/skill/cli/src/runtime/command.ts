// The shape every src/commands/<noun>-<verb>.ts exports: one Task as one command.
import type { z } from "zod";
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
