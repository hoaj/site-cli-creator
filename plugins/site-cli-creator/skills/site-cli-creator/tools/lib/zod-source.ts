import type { Shape } from "./shape";

const IDENT = /^[A-Za-z_$][\w$]*$/;

export function propertyKey(key: string): string {
  return IDENT.test(key) ? key : JSON.stringify(key);
}

function pad(level: number): string {
  return "  ".repeat(level);
}

/**
 * Zod 4 source for a Shape. Fields seen as null become `.nullable()`, keys seen
 * only sometimes become `.optional()`, and places with no observation become
 * `z.unknown()`.
 */
export function zodSource(shape: Shape | undefined, level = 0): string {
  if (!shape) return "z.unknown()";
  switch (shape.type) {
    case "string":
      return "z.string()";
    case "number":
      return "z.number()";
    case "boolean":
      return "z.boolean()";
    case "null":
      return "z.null()";
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
          ? "z.null()"
          : nonNull.length === 1
            ? zodSource(nonNull[0], level)
            : `z.union([${nonNull.map((s) => zodSource(s, level)).join(", ")}])`;
      return nullable && nonNull.length > 0 ? `${inner}.nullable()` : inner;
    }
  }
}
