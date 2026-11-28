// The draft of an HTML Operation's `html` block and `response` (ARCHITECTURE §6, draft-contract) from the
// outline the Capture recorded: the element repeated most is the list, its parent the list's container
// (`in`), and each element inside an item that has text, or an attribute worth reading, is a field. The
// agent then keeps the fields the command reads, names them, and decides which may be null.
import { selectOne } from "css-select";
import type { AnyNode, Element } from "domhandler";
import { parseHtml } from "../../starter/skill/cli/src/runtime/html";
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
      // A repeated element with values inside it is a nested list of its own; a repeated leaf (tags) is one field of all its matches.
      if (c.many && c !== root && leaves(c).length > 0) continue;
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

/** The site's own chrome: navigation, header and footer, by tag or by a class that names one. */
const CHROME_TAGS = new Set(["nav", "header", "footer", "aside"]);
const CHROME_CLASS = /(?:^|[-_])(?:menu|nav|navbar|navigation|breadcrumbs?|footer|header|pager|pagination)(?:$|[-_])/i;

function isChrome(n: HtmlNode): boolean {
  return CHROME_TAGS.has(n.tag) || (n.classes ?? []).some((c) => CHROME_CLASS.test(c));
}

/**
 * The list item: the repeated node with the most values in it, and the nodes above it. A list in the site's
 * chrome (a menu, a pager) loses to any other list, which is where the data is.
 */
function findList(nodes: HtmlNode[], above: HtmlNode[] = []): { item: HtmlNode; above: HtmlNode[] } | null {
  const rank = (c: { item: HtmlNode; above: HtmlNode[] }) => ([c.item, ...c.above].some(isChrome) ? 0 : 1_000_000) + score(c.item);
  let best: { item: HtmlNode; above: HtmlNode[] } | null = null;
  const consider = (c: { item: HtmlNode; above: HtmlNode[] } | null) => {
    if (c && (!best || rank(c) > rank(best))) best = c;
  };
  for (const n of nodes) {
    if (n.many && score(n) > 0) consider({ item: n, above });
    consider(findList(n.children ?? [], [...above, n]));
  }
  return best;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/**
 * The outline as a page skeleton, each node an element marked `data-o`: a drafted selector is tried on it the way
 * the runtime runs it (css-select's selectOne from the scope), so it picks the element it was drafted from and
 * not an earlier one that also matches (a nav's `ul`, a `span.icon` before the title's `span`, a header's `h2`).
 */
class Skeleton {
  private readonly marks = new Map<HtmlNode, string>();
  private readonly els = new Map<string, Element>();
  private readonly doc: ReturnType<typeof parseHtml>;

  constructor(outline: HtmlNode[]) {
    let next = 0;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const render = (node: HtmlNode): string => {
      const mark = String(next++);
      this.marks.set(node, mark);
      const attrs = [`data-o="${mark}"`];
      if (node.id) attrs.push(`id="${esc(node.id)}"`);
      if (node.classes?.length) attrs.push(`class="${esc(node.classes.join(" "))}"`);
      if (node.type) attrs.push(`type="${esc(node.type)}"`);
      for (const a of node.attrs ?? []) if (a !== "type" && /^[a-z][\w.:-]*$/i.test(a)) attrs.push(`${a}=""`);
      const open = `<${node.tag} ${attrs.join(" ")}>`;
      return VOID.has(node.tag) ? open : `${open}${(node.children ?? []).map(render).join("")}</${node.tag}>`;
    };
    // A fragment of table rows or cells (or options) only parses inside its own context, as it did on the page.
    const inner = outline.map(render).join("");
    const top = new Set(outline.map((n) => n.tag));
    const context = top.has("td") || top.has("th") ? ["<table><tbody><tr>", "</tr></tbody></table>"] : top.has("tr") ? ["<table><tbody>", "</tbody></table>"] : top.has("tbody") || top.has("thead") || top.has("tfoot") ? ["<table>", "</table>"] : top.has("option") ? ["<select>", "</select>"] : ["", ""];
    this.doc = parseHtml(`<!doctype html><html><body>${context[0]}${inner}${context[1]}</body></html>`);
    const walk = (nodes: AnyNode[]) => {
      for (const n of nodes) {
        const el = n as Element;
        if (!el.attribs) continue;
        if (el.attribs["data-o"] !== undefined) this.els.set(el.attribs["data-o"], el);
        walk(el.children as AnyNode[]);
      }
    };
    walk(this.doc.children as AnyNode[]);
  }

  /** Whether `css`, run from `scope` (null: the page) as the runtime runs it, first matches `target`. */
  picks(css: string, scope: HtmlNode | null, target: HtmlNode): boolean {
    const within = scope ? this.els.get(this.marks.get(scope) ?? "") : undefined;
    if (scope && !within) return false;
    try {
      const hit = selectOne<AnyNode, Element>(css, within ?? (this.doc.children as AnyNode[]));
      return hit !== null && hit.attribs["data-o"] === this.marks.get(target);
    } catch {
      return false;
    }
  }
}

/**
 * A selector for `path`'s last node, run from `scope`: the first of its own selector, the nearest named ancestor's
 * with it, and the child path, that picks it on the skeleton. Never a position (`:nth-of-type`): the outline
 * collapses repeated siblings, so it cannot know one. With none, the child path, with a TODO for the agent.
 */
function verifiedSelector(path: HtmlNode[], sk: Skeleton, scope: HtmlNode | null, pool: HtmlNode[], anchored = false): string {
  const target = path.at(-1)!;
  const own = selectorOf(target);
  const named = [...path.slice(0, -1)].reverse().find((n) => !isPlain(n));
  const child = path.map(selectorOf).join(" > ");
  const withNamed = named ? [`${selectorOf(named)} ${own}`] : [];
  // Set apart from other elements of its tag by the classes they have and it lacks (`span:not(.icon)`), or by having none.
  const others = pool.filter((n) => n !== target && n.tag === target.tag);
  const lacks = [...new Set(others.flatMap((n) => n.classes ?? []))].filter((c) => !(target.classes ?? []).includes(c) && /^-?[A-Za-z_][\w-]*$/.test(c));
  const negated = [...(lacks.length ? [`${own}${lacks.map((c) => `:not(.${c})`).join("")}`] : []), ...(!target.classes?.length && others.some((n) => n.classes?.length) ? [`${own}:not([class])`] : [])];
  // A container that is a bare tag (`ul`) breaks as soon as the page gains an earlier one: anchor it to a named ancestor first.
  const candidates = anchored && isPlain(target) ? [...withNamed, own, child, ...negated] : [own, ...withNamed, ...negated, child];
  const found = candidates.find((css) => sk.picks(css, scope, target));
  return found ? JSON.stringify(found) : `${JSON.stringify(child)} /* TODO: an earlier element matches this too: make it specific */`;
}

function uniqueName(name: string, used: Set<string>): string {
  let n = name || "field";
  for (let i = 2; used.has(n); i++) n = `${name}${i}`;
  used.add(n);
  return n;
}

/** The fields inside `root`, each selector verified on `sk` from `scope` (null: the page, `root` a stand-in for it). */
function fieldsOf(root: HtmlNode, used: Set<string>, ownAttrs: boolean, sk: Skeleton, scope: HtmlNode | null): Field[] {
  const fields: Field[] = [];
  if (ownAttrs) {
    for (const a of root.attrs ?? []) {
      if (!a.startsWith("data-") && !VALUE_ATTRS.includes(a)) continue;
      fields.push({ name: uniqueName(attrName(a), used), source: `{ css: ":scope", attr: ${JSON.stringify(a)} }`, zod: "z.string().nullable()" });
    }
  }
  const found = leaves(root);
  const pool: HtmlNode[] = [];
  const gather = (n: HtmlNode) => (n.children ?? []).forEach((c) => (pool.push(c), gather(c)));
  gather(root);
  for (const { node, path } of found) {
    if (fields.length >= MAX_FIELDS) break;
    const css = verifiedSelector(path, sk, scope, pool);
    const base = camel([node.classes?.[0] ?? (node.id !== ":id" ? node.id : undefined) ?? TAG_NAMES[node.tag] ?? node.tag].filter((x): x is string => !!x));
    if (node.json) {
      const type = node.type ? `[type=${JSON.stringify(node.type)}]` : "";
      fields.push({ name: uniqueName(base === "script" ? "data" : base, used), source: `{ css: ${JSON.stringify(`script${type}`)}, json: true }`, zod: zodSource(node.json, 2) });
      continue;
    }
    // A repeated element (tags, several dates) reads every match, so no value is lost.
    const all = node.many ? ", all: true" : "";
    const valueZod = node.many ? "z.array(z.string())" : "z.string().nullable()";
    // Values that only repeated <br> separates (a block of names) read as lines; one <br> after a label stays text.
    const brs = (node.children ?? []).filter((c) => c.tag === "br");
    const lines = !node.many && (brs.length > 1 || brs.some((c) => c.many));
    // Any other <br> may separate values too: a text field joins them with a space, so the draft says how to keep them.
    // The TODO never quotes the selector, which can end in a comment of its own (block comments do not nest).
    const brTodo = !brs.length || lines ? "" : node.many
      ? " /* TODO: a <br> inside: if it separates values, make this an { each, in, fields } list whose item field is { css: \":scope\", lines: true }, and its response z.array(z.object({ ...: z.array(z.string()) })) */"
      : " /* TODO: a <br> inside: if it separates values (not a label), { css, lines: true } keeps them apart, with z.array(z.string()).nullable() */";
    if (node.text && lines) fields.push({ name: uniqueName(base, used), source: `{ css: ${css}, lines: true }`, zod: "z.array(z.string()).nullable()" });
    else if (node.text) fields.push({ name: uniqueName(base, used), source: (node.many ? `{ css: ${css}${all} }` : css) + brTodo, zod: valueZod });
    for (const a of node.attrs ?? []) {
      if (!VALUE_ATTRS.includes(a) && !a.startsWith("data-")) continue;
      const name = node.text || base === (TAG_NAMES[node.tag] ?? node.tag) ? `${base}${attrName(a)[0]!.toUpperCase()}${attrName(a).slice(1)}` : base;
      fields.push({ name: uniqueName(name, used), source: `{ css: ${css}, attr: ${JSON.stringify(a)}${all} }`, zod: node.many ? "z.array(z.string().nullable())" : valueZod });
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
  const sk = new Skeleton(outline);
  let fieldsSource: string;
  let responseSource: string;
  if (list) {
    const parent = list.above.at(-1);
    // The container is the first element its selector matches on the page (a nav's ul comes first): verified.
    const everything: HtmlNode[] = [];
    const gatherAll = (ns: HtmlNode[]) => ns.forEach((n) => (everything.push(n), gatherAll(n.children ?? [])));
    gatherAll(outline);
    const container = parent ? verifiedSelector(list.above, sk, null, everything, true) : undefined;
    // `each` must match every item, not just the first: the item's own selector, never narrowed to one element.
    const each = JSON.stringify(selectorOf(list.item));
    const listName = camel([parent?.classes?.[0] ?? (parent?.id !== ":id" ? parent?.id : undefined) ?? "items"].filter((x): x is string => !!x));
    const itemFields = fieldsOf(list.item, new Set(), true, sk, list.item);
    const name = uniqueName(listName === parent?.tag ? "items" : listName, used);
    const inPart = container ? `, in: ${container}` : "";
    fieldsSource = [
      `      ${name}: {`,
      `        each: ${each}${inPart},`,
      "        fields: {",
      objectLines(itemFields, 5, "source"),
      "        },",
      "      },",
    ].join("\n");
    responseSource = [`  response: z.object({`, `    ${name}: z.array(`, "      z.object({", objectLines(itemFields, 4, "zod"), "      }),", "    ),", "  }),"].join("\n");
    lines.push(`  // The page answers HTML: html.fields picks the values with CSS selectors (the outline is in the shape`);
    lines.push(`  // file). Drafted: the repeated ${selectorOf(list.item)} as the list${container ? `, in its container ${JSON.parse(container.split(" /*")[0]!)}, which must be on` : "; give it a container (`in`) that is on"}`);
    lines.push(`  // the page even when the list is empty, so a changed layout is Drift instead of an empty list.`);
  } else {
    const fields = fieldsOf({ tag: "#root", children: outline }, used, false, sk, null);
    fieldsSource = objectLines(fields, 3, "source");
    responseSource = [`  response: z.object({`, objectLines(fields, 2, "zod"), "  }),"].join("\n");
    lines.push(`  // The page answers HTML: html.fields picks the values with CSS selectors (the outline is in the shape`);
    lines.push("  // file). No repeated element was seen, so each element with text (or a link, a date) is a field.");
  }
  lines.push("  // Keep the fields the command reads and name them. A field it cannot do without is z.string().min(1),");
  lines.push("  // so an element that moved or emptied is Drift; one another page may lack stays .nullable(). A lines list");
  lines.push("  // is null when its element moved, as text is, and [] when it is empty: one the command cannot do without");
  lines.push("  // is z.array(z.string()).min(1), one some items leave empty a plain z.array(z.string()) (a moved element");
  lines.push("  // is still Drift); keep .nullable() only for an element another page may lack. An all: true list reads []");
  lines.push("  // when its elements moved too: .min(1) there as well.");
  lines.push("  html: {");
  if (from) lines.push(`    from: ${from},`);
  lines.push("    fields: {", fieldsSource, "    },", "  },");
  lines.push(responseSource);
  return lines;
}

/**
 * `html.from` for the HTML at `path` (a Fingerprint path, as `htmlInJson` records it) inside a JSON answer:
 * a plain field path reads it, `[].<key>` takes the longest string at that key; anything else is left for the agent.
 */
export function fromSource(path: string): string {
  // The answer is itself one HTML string (a JSON-encoded fragment).
  if (path === "") return "(body: any) => body";
  const access = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `?.${key}` : `?.[${JSON.stringify(key)}]`);
  const keys = path.split(".");
  if (keys.every((k) => k && k !== "{}" && !k.includes("[]"))) return `(body: any) => body${keys.map(access).join("")}`;
  // The longest string at that key: the outline (and so the fields) came from the richest one (Drupal's `insert`
  // command, not an earlier `add_css` <link>).
  const firstOf = /^\[\]\.([^.[\]{}]+)$/.exec(path);
  if (firstOf) {
    const key = access(firstOf[1]!);
    return `(body: any) => (Array.isArray(body) ? body : []).map((item: any) => item${key}).filter((s: unknown): s is string => typeof s === "string").sort((a: string, b: string) => b.length - a.length)[0]`;
  }
  return `(body: any) => undefined /* TODO: return the HTML string at ${path} */`;
}
