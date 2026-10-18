// A deliberately small GraphQL engine for the fixture site: enough of the
// language (named operations, variables, nested selections, arguments,
// aliases, __typename) to answer the queries the fixture frontend and the
// expected CLI send, and to produce real-looking validation errors.
// Fragments and directives are not supported.

export type Value =
  | { kind: "var"; name: string }
  | { kind: "literal"; value: unknown }
  | { kind: "list"; items: Value[] }
  | { kind: "object"; fields: Record<string, Value> };

export type Field = {
  name: string;
  alias?: string;
  args: Record<string, Value>;
  selections?: Field[];
};

export type VariableDef = { name: string; type: string; required: boolean };

export type OperationDef = {
  type: "query" | "mutation";
  name?: string;
  variables: VariableDef[];
  selections: Field[];
};

export type GraphQLError = { message: string; path?: (string | number)[]; extensions: { code: string } };

export class GraphQLFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const TOKEN = /\s+|,|#[^\n]*|(\.\.\.|[{}()[\]:!$=@])|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([_A-Za-z][_0-9A-Za-z]*)/y;

type Token = { kind: "punct" | "string" | "number" | "name"; text: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(source);
    if (!m) throw new GraphQLFailure(`Syntax Error: Unexpected character at offset ${at}.`, "GRAPHQL_PARSE_FAILED");
    if (m[1]) tokens.push({ kind: "punct", text: m[1] });
    else if (m[2]) tokens.push({ kind: "string", text: m[2] });
    else if (m[3]) tokens.push({ kind: "number", text: m[3] });
    else if (m[4]) tokens.push({ kind: "name", text: m[4] });
  }
  return tokens;
}

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private next(): Token {
    const t = this.tokens[this.i++];
    if (!t) throw new GraphQLFailure("Syntax Error: Unexpected <EOF>.", "GRAPHQL_PARSE_FAILED");
    return t;
  }

  private is(text: string): boolean {
    const t = this.peek();
    return !!t && t.kind === "punct" && t.text === text;
  }

  private expect(text: string): void {
    const t = this.next();
    if (t.kind !== "punct" || t.text !== text)
      throw new GraphQLFailure(`Syntax Error: Expected "${text}", found "${t.text}".`, "GRAPHQL_PARSE_FAILED");
  }

  private name(): string {
    const t = this.next();
    if (t.kind !== "name") throw new GraphQLFailure(`Syntax Error: Expected Name, found "${t.text}".`, "GRAPHQL_PARSE_FAILED");
    return t.text;
  }

  document(): OperationDef[] {
    const ops: OperationDef[] = [];
    while (this.peek()) ops.push(this.operation());
    if (ops.length === 0) throw new GraphQLFailure("Syntax Error: Unexpected <EOF>.", "GRAPHQL_PARSE_FAILED");
    return ops;
  }

  private operation(): OperationDef {
    if (this.is("{")) return { type: "query", variables: [], selections: this.selectionSet() };
    const keyword = this.name();
    if (keyword !== "query" && keyword !== "mutation")
      throw new GraphQLFailure(`Syntax Error: Unexpected Name "${keyword}".`, "GRAPHQL_PARSE_FAILED");
    const t = this.peek();
    const name = t?.kind === "name" ? this.name() : undefined;
    const variables = this.is("(") ? this.variableDefs() : [];
    return { type: keyword, name, variables, selections: this.selectionSet() };
  }

  private variableDefs(): VariableDef[] {
    this.expect("(");
    const defs: VariableDef[] = [];
    while (!this.is(")")) {
      this.expect("$");
      const name = this.name();
      this.expect(":");
      const type = this.type();
      if (this.is("=")) {
        this.next();
        this.value();
      }
      defs.push({ name, type, required: type.endsWith("!") });
    }
    this.expect(")");
    return defs;
  }

  private type(): string {
    let text: string;
    if (this.is("[")) {
      this.next();
      text = `[${this.type()}]`;
      this.expect("]");
    } else {
      text = this.name();
    }
    if (this.is("!")) {
      this.next();
      text += "!";
    }
    return text;
  }

  private selectionSet(): Field[] {
    this.expect("{");
    const fields: Field[] = [];
    while (!this.is("}")) {
      if (this.is("...")) throw new GraphQLFailure("Fragments are not supported by the fixture site.", "GRAPHQL_PARSE_FAILED");
      if (this.is("@")) throw new GraphQLFailure("Directives are not supported by the fixture site.", "GRAPHQL_PARSE_FAILED");
      fields.push(this.field());
    }
    this.expect("}");
    return fields;
  }

  private field(): Field {
    let name = this.name();
    let alias: string | undefined;
    if (this.is(":")) {
      this.next();
      alias = name;
      name = this.name();
    }
    const args: Record<string, Value> = {};
    if (this.is("(")) {
      this.next();
      while (!this.is(")")) {
        const argName = this.name();
        this.expect(":");
        args[argName] = this.value();
      }
      this.expect(")");
    }
    const selections = this.is("{") ? this.selectionSet() : undefined;
    return { name, alias, args, selections };
  }

  private value(): Value {
    const t = this.next();
    if (t.kind === "punct" && t.text === "$") return { kind: "var", name: this.name() };
    if (t.kind === "string") return { kind: "literal", value: JSON.parse(t.text) };
    if (t.kind === "number") return { kind: "literal", value: Number(t.text) };
    if (t.kind === "name") {
      if (t.text === "true") return { kind: "literal", value: true };
      if (t.text === "false") return { kind: "literal", value: false };
      if (t.text === "null") return { kind: "literal", value: null };
      return { kind: "literal", value: t.text };
    }
    if (t.text === "[") {
      const items: Value[] = [];
      while (!this.is("]")) items.push(this.value());
      this.expect("]");
      return { kind: "list", items };
    }
    if (t.text === "{") {
      const fields: Record<string, Value> = {};
      while (!this.is("}")) {
        const key = this.name();
        this.expect(":");
        fields[key] = this.value();
      }
      this.expect("}");
      return { kind: "object", fields };
    }
    throw new GraphQLFailure(`Syntax Error: Unexpected "${t.text}".`, "GRAPHQL_PARSE_FAILED");
  }
}

export function parse(source: string): OperationDef[] {
  return new Parser(tokenize(source)).document();
}

// ---- schema and execution ----------------------------------------------

export type Resolver<C> = (parent: any, args: Record<string, unknown>, ctx: C) => unknown;

/**
 * `type` names another object type in the schema, or a scalar (any name not in `types`).
 * `args` maps each argument the field accepts to its GraphQL type (`!` = required).
 */
export type FieldDef<C> = { type: string; args?: Record<string, string>; resolve?: Resolver<C> };

export type Schema<C> = {
  query: string;
  mutation: string;
  types: Record<string, Record<string, FieldDef<C>>>;
};

export function validate<C>(schema: Schema<C>, op: OperationDef): GraphQLError[] {
  const errors: GraphQLError[] = [];
  const declared = new Set(op.variables.map((v) => v.name));
  const walk = (typeName: string, fields: Field[]) => {
    const type = schema.types[typeName]!;
    for (const field of fields) {
      for (const used of variablesIn(field.args)) {
        if (!declared.has(used))
          errors.push(validationError(`Variable "$${used}" is not defined by operation "${op.name ?? "anonymous"}".`));
      }
      if (field.name === "__typename") continue;
      const def = type[field.name];
      if (!def) {
        errors.push(validationError(`Cannot query field "${field.name}" on type "${typeName}".`));
        continue;
      }
      const accepted = def.args ?? {};
      for (const arg of Object.keys(field.args)) {
        if (!(arg in accepted)) errors.push(validationError(`Unknown argument "${arg}" on field "${typeName}.${field.name}".`));
      }
      for (const [arg, argType] of Object.entries(accepted)) {
        if (argType.endsWith("!") && !(arg in field.args))
          errors.push(validationError(`Field "${field.name}" argument "${arg}" of type "${argType}" is required, but it was not provided.`));
      }
      const isObject = def.type in schema.types;
      if (isObject && !field.selections)
        errors.push(validationError(`Field "${field.name}" of type "${def.type}" must have a selection of subfields.`));
      else if (!isObject && field.selections)
        errors.push(validationError(`Field "${field.name}" must not have a selection since type "${def.type}" has no subfields.`));
      else if (isObject) walk(def.type, field.selections!);
    }
  };
  walk(op.type === "query" ? schema.query : schema.mutation, op.selections);
  return errors;
}

function validationError(message: string): GraphQLError {
  return { message, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } };
}

function variablesIn(args: Record<string, Value>): string[] {
  const out: string[] = [];
  const visit = (v: Value) => {
    if (v.kind === "var") out.push(v.name);
    else if (v.kind === "list") v.items.forEach(visit);
    else if (v.kind === "object") Object.values(v.fields).forEach(visit);
  };
  Object.values(args).forEach(visit);
  return out;
}

/** Variables missing for non-null definitions, as BAD_USER_INPUT errors. Messages never echo values. */
export function checkVariables(op: OperationDef, variables: Record<string, unknown>): GraphQLError[] {
  return op.variables
    .filter((v) => v.required && (variables[v.name] === undefined || variables[v.name] === null))
    .map((v) => ({
      message: `Variable "$${v.name}" of required type "${v.type}" was not provided.`,
      extensions: { code: "BAD_USER_INPUT" },
    }));
}

function resolveValue(v: Value, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case "var":
      return variables[v.name];
    case "literal":
      return v.value;
    case "list":
      return v.items.map((i) => resolveValue(i, variables));
    case "object":
      return Object.fromEntries(Object.entries(v.fields).map(([k, f]) => [k, resolveValue(f, variables)]));
  }
}

/**
 * Executes a validated operation. A resolver that throws GraphQLFailure nulls
 * its field and adds an error with that code, as a GraphQL server would.
 */
export async function execute<C>(
  schema: Schema<C>,
  op: OperationDef,
  variables: Record<string, unknown>,
  ctx: C,
): Promise<{ data: Record<string, unknown> | null; errors?: GraphQLError[] }> {
  const errors: GraphQLError[] = [];
  const selectObject = async (typeName: string, parent: unknown, fields: Field[], path: (string | number)[]) => {
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      const key = field.alias ?? field.name;
      if (field.name === "__typename") {
        out[key] = typeName;
        continue;
      }
      const def = schema.types[typeName]![field.name]!;
      const args = Object.fromEntries(
        Object.entries(field.args).map(([k, v]) => [k, resolveValue(v, variables)]),
      );
      try {
        const raw = def.resolve ? await def.resolve(parent, args, ctx) : (parent as Record<string, unknown>)[field.name];
        out[key] = await complete(def.type, raw, field, [...path, key]);
      } catch (e) {
        if (!(e instanceof GraphQLFailure)) throw e;
        out[key] = null;
        errors.push({ message: e.message, path: [...path, key], extensions: { code: e.code } });
      }
    }
    return out;
  };
  const complete = async (typeName: string, raw: unknown, field: Field, path: (string | number)[]): Promise<unknown> => {
    if (raw === null || raw === undefined) return null;
    if (Array.isArray(raw)) return Promise.all(raw.map((item, i) => complete(typeName, item, field, [...path, i])));
    if (typeName in schema.types) return selectObject(typeName, raw, field.selections!, path);
    return raw;
  };
  const root = op.type === "query" ? schema.query : schema.mutation;
  const data = await selectObject(root, {}, op.selections, []);
  return errors.length ? { data, errors } : { data };
}
