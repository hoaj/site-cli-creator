// The Contract every src/operations/<name>.ts exports (SPEC §6).
import type { z } from "zod";
import type { Page } from "playwright-core";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Where `check` gets a variable: a chain-root id from the session (`key` "account" means the
 * selected --account), an earlier Operation's parsed result, or a constant (`{ value: 25 }`: what a
 * command passes for a fixed parameter such as a page size or a sort order). A required variable
 * without an entry can never be checked: `check` skips the Operation and lists it in `warnings`.
 */
export type Need =
  | { from: "session"; key: string }
  | { from: string; pick(result: any): unknown }
  | { value: unknown };

export type Operation<V extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> = {
  /** GraphQL operationName, or "METHOD /path/:param" for REST. */
  name: string;
  /** Declared, never inferred from the method. */
  effect: "read" | "write";
  /** Trimmed GraphQL query: only the fields the CLI reads. POSTed to origin + site.graphqlPath. */
  graphql?: string;
  /**
   * REST request. `:name` segments in `path` are filled from variables. `body` builds the request
   * body from variables, sent as JSON, or form-urlencoded when `bodyType` is "form" (a flat object
   * of strings, numbers, booleans or arrays of them). For `check --writes`, the intercepted request's
   * path params, query and body fields (JSON or form, by its content-type) are merged into one object
   * and checked against `variables`; a body that is no object is the variable `body`. So a Contract
   * keeps each body field a top-level variable: `body: (v) => ({ name: v.name })`.
   */
  rest?: {
    method: Method;
    path: string;
    body?(vars: z.output<V>): unknown;
    /** How `body` is encoded: "json" (the default) or "form" (application/x-www-form-urlencoded). */
    bodyType?: "json" | "form";
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
