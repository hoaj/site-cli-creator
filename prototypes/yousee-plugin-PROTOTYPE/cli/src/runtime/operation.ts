// FIXED TEMPLATE FILE. PROTOTYPE.
// The shape every agent-written src/operations/<name>.ts must export
// (from "Contract format per endpoint").
import type { z } from "zod";

export type Operation<V extends z.ZodTypeAny = z.ZodTypeAny, R extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;                      // GraphQL operationName, or "METHOD /path" for REST
  effect: "read" | "write";          // declared, never inferred from method
  graphql?: string;                  // trimmed query: only fields the CLI reads
  rest?: { method: string; path: string };
  variables: V;
  response: R;
  // Where `check` gets each variable: another Operation's result, or the session.
  needs?: Record<string, { from: string; pick: (result: any) => unknown }>;
  // Writes only: drive the UI up to the request; `check` intercepts and aborts it.
  trigger?: (page: import("playwright-core").Page) => Promise<void>;
};

export const defineOperation = <V extends z.ZodTypeAny, R extends z.ZodTypeAny>(op: Operation<V, R>) => op;
