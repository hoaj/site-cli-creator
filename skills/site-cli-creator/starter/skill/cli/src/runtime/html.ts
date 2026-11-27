// HTML Operations (SPEC §6): a page, an HTML fragment, or HTML inside a JSON answer, whose values the
// Contract picks with CSS selectors (`html.fields`). The picked object is then parsed by `response`
// like any JSON body, so a changed layout shows up as Drift: a list's container that is gone
// (`no_match`), inline JSON that no longer parses (`invalid_json`), or, through Zod, a field that is
// now missing or empty.
import { selectAll, selectOne } from "css-select";
import type { AnyNode, Document, Element } from "domhandler";
import * as DomUtils from "domutils";
import { parse, parseFragment } from "parse5";
import { adapter } from "parse5-htmlparser2-tree-adapter";
import { ContractError } from "./envelope";

/**
 * How one value is picked, relative to the page or to the list item it sits in:
 * - `"h2.title"`: the first match's text (whitespace collapsed, trimmed), or null when nothing matches;
 * - `{ css, attr }`: the first match's attribute instead (null when the element or the attribute is missing);
 * - `{ css, all: true }`: every match's text (or `attr`), as a list;
 * - `{ css, json: true }`: the first match's text parsed as JSON, for inline state
 *   (`<script type="application/ld+json">`, `<script id="__NEXT_DATA__">`); null when nothing matches;
 * - `{ css, lines: true }`: the first match's text split at `<br>` and block boundaries (a newline in the
 *   text, even in `<pre>`, is a space), each line collapsed and trimmed, empty lines left out, as a list;
 *   `[]` when nothing matches;
 * - `{ each, in?, fields }`: a list, one object per element matching `each`, its `fields` picked inside
 *   that element. `in` names the list's container, which must be on the page even when the list is
 *   empty: without it a changed layout would read as an empty list instead of Drift.
 *
 * `css: ":scope"` is the list item itself (`{ css: ":scope", attr: "data-id" }`).
 */
export type HtmlField =
  | string
  | { css: string; attr?: string; all?: boolean; json?: boolean; lines?: never }
  | { css: string; lines: true; attr?: never; all?: never; json?: never }
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

/** The lists in `fields` with no container (`in`), as paths (`events`, `events[].tags`): regen.ts warns about each. */
export function listsWithoutContainer(fields: HtmlFields, prefix = ""): string[] {
  const out: string[] = [];
  for (const [name, field] of Object.entries(fields)) {
    if (typeof field !== "object" || !("each" in field)) continue;
    const path = prefix ? `${prefix}.${name}` : name;
    if (field.in === undefined) out.push(path);
    out.push(...listsWithoutContainer(field.fields, `${path}[]`));
  }
  return out;
}

/** regen.ts's warning for a list `listsWithoutContainer` found. */
export function noContainerWarning(operation: string, path: string): string {
  return `${operation}: the html list ${path} has no container (in), so a changed layout reads as an empty list instead of Drift. Set in to the element that holds the list, which the page has even when the list is empty.`;
}

type Doc = Document;
type Node = AnyNode;

/**
 * `html` as a browser builds it (parse5 follows the HTML standard: an open `<p>` ends at the next `<li>`,
 * a missing `</li>` is implied). A whole page (`<!doctype html` or `<html` in its first 4 KB) is parsed as a document, anything
 * else (a fragment from an HTML or JSON answer) as a fragment, so its table rows stay rows.
 */
export function parseHtml(html: string): Doc {
  // A doctype or <html> near the start, even after output a server printed first (a PHP notice), is a page.
  const doc = /<(?:!doctype\s+html|html[\s>])/i.test(html.slice(0, 4096))
    ? parse(html, { treeAdapter: adapter })
    : parseFragment(html, { treeAdapter: adapter });
  // A <template>'s content is inert: a browser's selectors never match inside it, so neither do ours.
  for (const t of DomUtils.findAll((el) => el.name === "template", doc.children)) DomUtils.removeElement(t);
  return doc;
}

class Mismatch {
  constructor(
    readonly path: string,
    readonly code: "no_match" | "invalid_json",
  ) {}
}

/** Picks `fields` out of `html`. Never throws for the page's content; a selector the parser refuses is a ContractError. */
export function extractHtml(html: string, fields: HtmlFields): Extracted {
  const doc = parseHtml(html);
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
    else if (field.lines) out[name] = segmentsOf(first(scope, field.css)).map(collapse).filter((line) => line !== "");
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

/** Whether a content-type header names HTML: `text/html` or `application/xhtml+xml` (parameters ignored). */
export function isHtmlType(contentType: string | null | undefined): boolean {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml";
}

/** Whether `css` parses, as css-select reads it: undefined when it does, else the parser's message. */
export function selectorProblem(css: string): string | undefined {
  try {
    selectOne(css, []);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Whether any element of `html` matches `css` (login.signedOutSelector, SPEC §7). A selector the parser refuses is a ContractError. */
export function htmlMatches(html: string, css: string): boolean {
  return compiled(css, () => selectOne<Node, Element>(css, parseHtml(html).children)) !== null;
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

/** Elements a browser shows on a line (or in a cell) of their own: a space between their texts. */
const BREAKS = new Set([
  "br", "p", "div", "li", "ul", "ol", "dl", "dt", "dd", "tr", "td", "th", "table", "thead", "tbody", "tfoot", "caption",
  "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer", "nav", "main", "aside", "blockquote",
  "pre", "figure", "figcaption", "address", "form", "fieldset", "legend", "hr", "details", "summary",
]);
/** Never visible text: a <noscript> holds markup (parse5 parses it as text, as a browser with scripts on does). */
const HIDDEN = new Set(["noscript", "template"]);

/** An element's text: whitespace collapsed, `<br>` and block boundaries a space, scripts, styles and `<noscript>` inside it left out. */
function textOf(el: Element | null): string | null {
  return el ? collapse(segmentsOf(el).join(" ")) : null;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** An element's raw text, split at `<br>` and block boundaries (none when `el` is null); scripts, styles and `<noscript>` left out. */
function segmentsOf(el: Element | null): string[] {
  if (!el) return [];
  const segments = [""];
  const walk = (node: Node) => {
    if (node.type === "text") segments[segments.length - 1] += (node as { data: string }).data;
    else if (node.type === "tag") {
      const tag = (node as Element).name;
      if (HIDDEN.has(tag)) return;
      if (BREAKS.has(tag)) segments.push("");
      for (const child of (node as Element).children) walk(child as Node);
      if (BREAKS.has(tag)) segments.push("");
    }
  };
  for (const child of el.children) walk(child as Node);
  return segments;
}
