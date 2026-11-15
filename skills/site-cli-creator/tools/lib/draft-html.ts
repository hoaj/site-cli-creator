// The draft of an HTML Operation's `html` block and `response` (ARCHITECTURE §6, draft-contract) from the
// outline the Capture recorded: the element repeated most is the list, its parent the list's container
// (`in`), and each element inside an item that has text, or an attribute worth reading, is a field. The
// agent then keeps the fields the command reads, names them, and decides which may be null.
import type { HtmlNode } from "./html-outline";
import { zodSource } from "./zod-source";

/** Attributes a field reads instead of text: where a link goes, a machine-readable date, an image. */
const VALUE_ATTRS = ["href", "datetime", "src", "content", "value"];
const MAX_FIELDS = 16;
/** Field names for elements with no class or id to name them by. */
const TAG_NAMES: Record<string, string> = { a: "link", img: "image", h1: "heading", h2: "heading", h3: "heading", p: "text", span: "text", td: "cell" };

type Field = { name: string; source: string; zod: string };

function camel(words: string[]): string {
  const parts = words.flatMap((w) => w.split(/[^A-Za-z0-9]+/)).filter(Boolean);
  const name = parts.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join("");
  return /^[A-Za-z_$]/.test(name) ? name : `f${name}`;
}

/** `ul.events`, `li#main.event`: tag, a stable id, classes. */
export function selectorOf(n: HtmlNode): string {
  const id = n.id && n.id !== ":id" && /^[A-Za-z][\w-]*$/.test(n.id) ? `#${n.id}` : "";
  const classes = (n.classes ?? []).filter((c) => /^-?[A-Za-z_][\w-]*$/.test(c)).map((c) => `.${c}`).join("");
  return `${n.tag}${id}${classes}`;
}

function isPlain(n: HtmlNode): boolean {
  return selectorOf(n) === n.tag;
}

function attrName(attr: string): string {
  if (attr === "href") return "url";
  if (attr === "datetime") return "date";
  if (attr.startsWith("data-")) return camel([attr.slice(5)]);
  return camel([attr]);
}

/** The value-bearing nodes inside `root` (not inside a nested list), with their path from it. */
function leaves(root: HtmlNode): { node: HtmlNode; path: HtmlNode[] }[] {
  const out: { node: HtmlNode; path: HtmlNode[] }[] = [];
  const walk = (n: HtmlNode, path: HtmlNode[]) => {
    for (const c of n.children ?? []) {
      if (c.many && c !== root) continue; // a nested list is a list of its own
      if (c.text || (c.attrs ?? []).some((a) => VALUE_ATTRS.includes(a) || a.startsWith("data-")) || c.json) out.push({ node: c, path: [...path, c] });
      walk(c, [...path, c]);
    }
  };
  walk(root, []);
  return out;
}

function score(n: HtmlNode): number {
  return leaves(n).length;
}

/** The list item: the repeated node with the most values in it, and the nodes above it. */
function findList(nodes: HtmlNode[], above: HtmlNode[] = []): { item: HtmlNode; above: HtmlNode[] } | null {
  let best: { item: HtmlNode; above: HtmlNode[] } | null = null;
  for (const n of nodes) {
    if (n.many && score(n) > 0 && (!best || score(n) > score(best.item))) best = { item: n, above };
    const inner = findList(n.children ?? [], [...above, n]);
    if (inner && (!best || score(inner.item) > score(best.item))) best = inner;
  }
  return best;
}

/** A selector for `path`'s last node relative to the scope: its own, or with the nearest named ancestor in front. */
function relativeSelector(path: HtmlNode[], siblings: { node: HtmlNode; path: HtmlNode[] }[]): string {
  const own = selectorOf(path.at(-1)!);
  const clash = siblings.filter((s) => selectorOf(s.node) === own).length > 1;
  if (!clash) return own;
  const named = [...path.slice(0, -1)].reverse().find((n) => !isPlain(n));
  return named ? `${selectorOf(named)} ${own}` : path.map(selectorOf).join(" > ");
}

function uniqueName(name: string, used: Set<string>): string {
  let n = name || "field";
  for (let i = 2; used.has(n); i++) n = `${name}${i}`;
  used.add(n);
  return n;
}

function fieldsOf(root: HtmlNode, used: Set<string>, ownAttrs: boolean): Field[] {
  const fields: Field[] = [];
  if (ownAttrs) {
    for (const a of root.attrs ?? []) {
      if (!a.startsWith("data-") && !VALUE_ATTRS.includes(a)) continue;
      fields.push({ name: uniqueName(attrName(a), used), source: `{ css: ":scope", attr: ${JSON.stringify(a)} }`, zod: "z.string().nullable()" });
    }
  }
  const found = leaves(root);
  for (const { node, path } of found) {
    if (fields.length >= MAX_FIELDS) break;
    const css = relativeSelector(path, found);
    const base = camel([node.classes?.[0] ?? (node.id !== ":id" ? node.id : undefined) ?? TAG_NAMES[node.tag] ?? node.tag].filter((x): x is string => !!x));
    if (node.json) {
      const type = node.type ? `[type=${JSON.stringify(node.type)}]` : "";
      fields.push({ name: uniqueName(base === "script" ? "data" : base, used), source: `{ css: ${JSON.stringify(`script${type}`)}, json: true }`, zod: zodSource(node.json, 2) });
      continue;
    }
    if (node.text) fields.push({ name: uniqueName(base, used), source: JSON.stringify(css), zod: "z.string().nullable()" });
    for (const a of node.attrs ?? []) {
      if (!VALUE_ATTRS.includes(a) && !a.startsWith("data-")) continue;
      const name = node.text || base === (TAG_NAMES[node.tag] ?? node.tag) ? `${base}${attrName(a)[0]!.toUpperCase()}${attrName(a).slice(1)}` : base;
      fields.push({ name: uniqueName(name, used), source: `{ css: ${JSON.stringify(css)}, attr: ${JSON.stringify(a)} }`, zod: "z.string().nullable()" });
    }
  }
  return fields.slice(0, MAX_FIELDS);
}

function objectLines(fields: Field[], level: number, key: "source" | "zod"): string {
  const pad = "  ".repeat(level);
  return fields.map((f) => `${pad}${f.name}: ${f[key]},`).join("\n");
}

/**
 * Source lines for `html: {...}` and `response: ...` (each starting at two spaces' indent), from an outline.
 * `from`: the source of `html.from`, when the HTML sits inside a JSON answer.
 */
export function draftHtml(outline: HtmlNode[], from?: string): string[] {
  const lines: string[] = [];
  const list = findList(outline);
  const used = new Set<string>();
  let fieldsSource: string;
  let responseSource: string;
  if (list) {
    const parent = list.above.at(-1);
    const named = [...list.above].reverse().find((n) => !isPlain(n));
    const container = parent ? (isPlain(parent) && named && named !== parent ? `${selectorOf(named)} ${parent.tag}` : selectorOf(parent)) : undefined;
    const listName = camel([parent?.classes?.[0] ?? (parent?.id !== ":id" ? parent?.id : undefined) ?? "items"].filter((x): x is string => !!x));
    const itemFields = fieldsOf(list.item, new Set(), true);
    const name = uniqueName(listName === parent?.tag ? "items" : listName, used);
    const inPart = container ? `, in: ${JSON.stringify(container)}` : "";
    fieldsSource = [
      `      ${name}: {`,
      `        each: ${JSON.stringify(selectorOf(list.item))}${inPart},`,
      "        fields: {",
      objectLines(itemFields, 5, "source"),
      "        },",
      "      },",
    ].join("\n");
    responseSource = [`  response: z.object({`, `    ${name}: z.array(`, "      z.object({", objectLines(itemFields, 4, "zod"), "      }),", "    ),", "  }),"].join("\n");
    lines.push(`  // The page answers HTML: html.fields picks the values with CSS selectors (the outline is in the shape`);
    lines.push(`  // file). Drafted: the repeated ${selectorOf(list.item)} as the list${container ? `, in its container ${container}, which must be on` : "; give it a container (`in`) that is on"}`);
    lines.push(`  // the page even when the list is empty, so a changed layout is Drift instead of an empty list.`);
  } else {
    const fields = outline.flatMap((n) => fieldsOf({ tag: "#root", children: [n] }, used, false)).slice(0, MAX_FIELDS);
    fieldsSource = objectLines(fields, 3, "source");
    responseSource = [`  response: z.object({`, objectLines(fields, 2, "zod"), "  }),"].join("\n");
    lines.push(`  // The page answers HTML: html.fields picks the values with CSS selectors (the outline is in the shape`);
    lines.push("  // file). No repeated element was seen, so each element with text (or a link, a date) is a field.");
  }
  lines.push("  // Keep the fields the command reads and name them. A field it cannot do without is z.string().min(1),");
  lines.push("  // so an element that moved or emptied is Drift; one another page may lack stays .nullable().");
  lines.push("  html: {");
  if (from) lines.push(`    from: ${from},`);
  lines.push("    fields: {", fieldsSource, "    },", "  },");
  lines.push(responseSource);
  return lines;
}

/**
 * `html.from` for the HTML at `path` (a Fingerprint path, as `htmlInJson` records it) inside a JSON answer:
 * a plain field path reads it, `[].<key>` takes the first array item whose key is a string; anything else
 * is left for the agent.
 */
export function fromSource(path: string): string {
  const plain = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
  if (plain.test(path)) return `(body: any) => body?.${path.split(".").join("?.")}`;
  const firstOf = /^\[\]\.([A-Za-z_$][\w$]*)$/.exec(path);
  if (firstOf) {
    const key = firstOf[1]!;
    return `(body: any) => (Array.isArray(body) ? body : []).find((item: any) => typeof item?.${key} === "string")?.${key}`;
  }
  return `(body: any) => undefined /* TODO: return the HTML string at ${path} */`;
}
