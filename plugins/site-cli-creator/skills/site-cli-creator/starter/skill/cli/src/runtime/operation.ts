// The Contract every src/operations/<name>.ts exports (SPEC §6).
import type { z } from "zod";
import type { Page } from "playwright-core";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Where `check` gets a variable: a chain-root id from the session (`key` "account" means the
 * selected --account), or an earlier Operation's parsed result.
 */
export type Need =
  | { from: "session"; key: string }
  | { from: string; pick(result: any): unknown };

export type Operation<V extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> = {
  /** GraphQL operationName, or "METHOD /path/:param" for REST. */
  name: string;
  /** Declared, never inferred from the method. */
  effect: "read" | "write";
  /** Trimmed GraphQL query: only the fields the CLI reads. POSTed to origin + site.graphqlPath. */
  graphql?: string;
  /**
   * REST request. `:name` segments in `path` are filled from variables. For `check --writes`,
   * the intercepted request's path params, query and JSON body fields are merged and checked
   * against `variables`.
   */
  rest?: {
    method: Method;
    path: string;
    body?(vars: z.output<V>): unknown;
    query?(vars: z.output<V>): Record<string, string>;
  };
  /** Validated before any call; a failure is `input` and nothing is sent. */
  variables: V;
  /** Only the fields the CLI reads; a parse failure is Drift. */
  response: R;
  needs?: Record<string, Need>;
  /** Writes only: drives the UI (relative URLs resolve against the site origin) up to the request, which `check --writes` intercepts and aborts. */
  trigger?(page: Page): Promise<void>;
};

export type AnyOperation = Operation<z.ZodType, z.ZodType>;

export const defineOperation = <V extends z.ZodType, R extends z.ZodType>(op: Operation<V, R>): Operation<V, R> => op;
