import type { Shape } from "./shape";

const IDENT = /^[A-Za-z_$][\w$]*$/;

export function propertyKey(key: string): string {
  return IDENT.test(key) ? key : JSON.stringify(key);
}

function pad(level: number): string {
  return "  ".repeat(level);
}

/** A place only ever seen as null: its type is unknown, so the draft says so instead of locking in `z.null()`. */
const ONLY_NULL = "z.unknown().nullable() /* TODO: only null was seen; decide the type */";

const FORMAT_NOTE = { numeric: "numeric string", date: "ISO date string", datetime: "ISO date-time string" } as const;

/**
 * Zod 4 source for a Shape. Fields seen as null become `.nullable()`, keys seen
 * only sometimes become `.optional()`, places only seen as null become
 * `z.unknown().nullable()` with a TODO, and places with no observation become
 * `z.unknown()`. A string's format class is noted in a comment.
 */
export function zodSource(shape: Shape | undefined, level = 0): string {
  if (!shape) return "z.unknown()";
  switch (shape.type) {
    case "string":
      return shape.format ? `z.string() /* ${FORMAT_NOTE[shape.format]} */` : "z.string()";
    case "number":
      return "z.number()";
    case "boolean":
      return "z.boolean()";
    case "null":
      return ONLY_NULL;
    case "array":
      return `z.array(${zodSource(shape.items, level)})`;
    case "record":
      return `z.record(z.string(), ${zodSource(shape.values, level)})`;
    case "object": {
      const keys = Object.keys(shape.fields);
      if (keys.length === 0) return "z.object({})";
      const optional = new Set(shape.optional ?? []);
      const lines = keys.map((key) => {
        const value = zodSource(shape.fields[key], level + 1);
        return `${pad(level + 1)}${propertyKey(key)}: ${value}${optional.has(key) ? ".optional()" : ""},`;
      });
      return `z.object({\n${lines.join("\n")}\n${pad(level)}})`;
    }
    case "union": {
      const nonNull = shape.anyOf.filter((s) => s.type !== "null");
      const nullable = nonNull.length < shape.anyOf.length;
      const inner =
        nonNull.length === 0
          ? ONLY_NULL
          : nonNull.length === 1
            ? zodSource(nonNull[0], level)
            : `z.union([${nonNull.map((s) => zodSource(s, level)).join(", ")}])`;
      return nullable && nonNull.length > 0 ? `${inner}.nullable()` : inner;
    }
  }
}
