// FIXED TEMPLATE FILE. PROTOTYPE.
// The shape every agent-written src/commands/<group>-<verb>.ts must export.
// Task commands compose Operations; the agent never sees Operation names.
import type { z } from "zod";
import type { Operation } from "./operation";

export type Command<A extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;                      // "subscription show" — group + verb
  summary: string;                   // one line, shown in `help` and SKILL.md
  args: A;                           // flags, validated before any call (input kind)
  uses: Operation[];                 // for SKILL.md and for `check --command`
  run: (args: z.infer<A>, call: Call) => Promise<unknown>;
};

export type Call = <O extends Operation>(op: O, vars: z.infer<O["variables"]>) => Promise<z.infer<O["response"]>>;

export const defineCommand = <A extends z.ZodTypeAny>(c: Command<A>) => c;
