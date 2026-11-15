// HTML Operations (SPEC §6): a page, an HTML fragment, or HTML inside a JSON answer, whose values the
// Contract picks with CSS selectors (`html.fields`). The picked object is then parsed by `response`
// like any JSON body, so a changed layout shows up as Drift: a list's container that is gone
// (`no_match`), inline JSON that no longer parses (`invalid_json`), or, through Zod, a field that is
// now missing or empty.
import { selectAll, selectOne } from "css-select";
import { DomUtils, parseDocument } from "htmlparser2";
import { ContractError } from "./envelope";

/**
 * How one value is picked, relative to the page or to the list item it sits in:
 * - `"h2.title"`: the first match's text (whitespace collapsed, trimmed), or null when nothing matches;
 * - `{ css, attr }`: the first match's attribute instead (null when the element or the attribute is missing);
 * - `{ css, all: true }`: every match's text (or `attr`), as a list;
 * - `{ css, json: true }`: the first match's text parsed as JSON, for inline state
 *   (`<script type="application/ld+json">`, `<script id="__NEXT_DATA__">`); null when nothing matches;
 * - `{ each, in?, fields }`: a list, one object per element matching `each`, its `fields` picked inside
 *   that element. `in` names the list's container, which must be on the page even when the list is
 *   empty: without it a changed layout would read as an empty list instead of Drift.
 *
 * `css: ":scope"` is the list item itself (`{ css: ":scope", attr: "data-id" }`).
 */
export type HtmlField =
  | string
  | { css: string; attr?: string; all?: boolean; json?: boolean }
  | { each: string; in?: string; fields: HtmlFields };

export type HtmlFields = Record<string, HtmlField>;

export type HtmlContract = {
  /**
   * When the HTML comes inside a JSON answer (Drupal's /views/ajax, a CMS field): returns the HTML
   * string from the parsed body. Throwing, or returning anything but a string, is Drift at `from`.
   */
  from?(body: unknown): unknown;
  fields: HtmlFields;
};

export type Extracted = { ok: true; value: Record<string, unknown> } | { ok: false; path: string; code: "no_match" | "invalid_json" };

type Doc = ReturnType<typeof parseDocument>;
type Node = Doc["children"][number];
type Element = Parameters<typeof DomUtils.getAttributeValue>[0];

class Mismatch {
  constructor(
    readonly path: string,
    readonly code: "no_match" | "invalid_json",
  ) {}
}

/** Picks `fields` out of `html`. Never throws for the page's content; a selector the parser refuses is a ContractError. */
export function extractHtml(html: string, fields: HtmlFields): Extracted {
  const doc = parseDocument(html);
  try {
    return { ok: true, value: pick(doc, fields, "") };
  } catch (e) {
    if (e instanceof Mismatch) return { ok: false, path: e.path, code: e.code };
    throw e;
  }
}

function pick(scope: Doc | Element, fields: HtmlFields, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (typeof field === "string") out[name] = textOf(first(scope, field));
    else if ("each" in field) out[name] = list(scope, field, path);
    else out[name] = value(scope, field, path);
  }
  return out;
}

function list(scope: Doc | Element, field: { each: string; in?: string; fields: HtmlFields }, path: string): Record<string, unknown>[] {
  let within: Doc | Element = scope;
  if (field.in !== undefined) {
    const container = first(scope, field.in);
    if (!container) throw new Mismatch(path, "no_match");
    within = container;
  }
  return all(within, field.each).map((item) => pick(item, field.fields, `${path}[]`));
}

function value(scope: Doc | Element, field: { css: string; attr?: string; all?: boolean; json?: boolean }, path: string): unknown {
  const read = (el: Element | null): unknown => {
    if (!el) return null;
    if (field.attr !== undefined) return DomUtils.getAttributeValue(el, field.attr) ?? null;
    if (!field.json) return textOf(el);
    try {
      return JSON.parse(DomUtils.textContent(el));
    } catch {
      throw new Mismatch(path, "invalid_json");
    }
  };
  if (field.all) return all(scope, field.css).map(read);
  return read(first(scope, field.css));
}

function isScope(css: string): boolean {
  return css.trim() === ":scope";
}

function first(scope: Doc | Element, css: string): Element | null {
  if (isScope(css)) return scope.type === "root" ? null : (scope as Element);
  return compiled(css, () => selectOne<Node, Element>(css, scope.type === "root" ? scope.children : (scope as Element)));
}

function all(scope: Doc | Element, css: string): Element[] {
  if (isScope(css)) return scope.type === "root" ? [] : [scope as Element];
  return compiled(css, () => selectAll<Node, Element>(css, scope.type === "root" ? scope.children : (scope as Element)));
}

/** A selector css-select cannot parse is the Contract's own mistake (a bug), never the site's. */
function compiled<T>(css: string, run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof Mismatch) throw e;
    throw new ContractError(`html.fields: the CSS selector ${JSON.stringify(css)} does not parse (${(e as Error).message})`);
  }
}

const BREAKS = new Set(["br", "p", "div", "li", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "dt", "dd"]);

/** An element's text: whitespace collapsed, `<br>` and block boundaries a space, scripts and styles inside it left out. */
function textOf(el: Element | null): string | null {
  if (!el) return null;
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.type === "text") parts.push((node as { data: string }).data);
    else if (node.type === "tag") {
      const tag = (node as Element).name;
      if (BREAKS.has(tag)) parts.push(" ");
      for (const child of (node as Element).children) walk(child as Node);
      if (BREAKS.has(tag)) parts.push(" ");
    }
  };
  for (const child of el.children) walk(child as Node);
  return parts.join("").replace(/\s+/g, " ").trim();
}
