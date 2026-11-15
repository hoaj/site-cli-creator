// The outline of an HTML answer (a page, a fragment, or HTML inside JSON): what an HTML Operation's
// `html.fields` selectors are written from (SPEC §6). Like every Shape it holds no values: tag names,
// ids and classes that are site code, attribute names, and whether an element has text of its own,
// never the text or an attribute's value. Repeated siblings (a list's items) collapse into one node
// marked `many`, so a page of 500 events is one item's outline.
import type { AnyNode, Element } from "domhandler";
import * as DomUtils from "domutils";
import { parseHtml } from "../../starter/skill/cli/src/runtime/html";
import { isIdLike, isValueLikeKey, mergeOptional, shapeOf, type Shape } from "./shape";

export type HtmlNode = {
  tag: string;
  /** The element's id, or ":id" when it carries data (`event-12345`). */
  id?: string;
  /** Class names, without those that carry data. */
  classes?: string[];
  /** Attribute names (not class, id or style), never their values. */
  attrs?: string[];
  /** `<script type>` or `<input type>`: a media type or an input kind, kept to tell inline JSON and form fields apart. */
  type?: string;
  /** The element has text of its own (never recorded). */
  text?: true;
  /** It repeats among its siblings: a list item. */
  many?: true;
  /** Inline JSON (`<script type="application/ld+json">`, `application/json`): its Shape. */
  json?: Shape;
  children?: HtmlNode[];
};

export type HtmlOutline = { outline: HtmlNode[]; truncated?: true };

type Node = AnyNode;

/** Elements whose content is never page data: dropped with everything in them. */
const DROPPED = new Set(["style", "noscript", "template", "link", "meta", "base", "title"]);
/** Kept as a leaf: their insides are graphics or another document. */
const LEAVES = new Set(["svg", "iframe", "object", "canvas", "video", "audio", "picture"]);
const MAX_DEPTH = 60;
const MAX_NODES = 4000;
const SAFE_TYPE = /^[a-z0-9.+/-]{1,40}$/i;

/** An HTML string, as a JSON field can carry one: starts with a tag and closes one. */
export function looksLikeHtml(text: string): boolean {
  return /^\s*<(?:[a-z][\w-]*|!doctype)[\s>/]/i.test(text) && /<\/[a-z][\w-]*\s*>\s*$/i.test(text);
}

/** The outline of `html`; `remember` gets each text and inline JSON string, for redacting paths that carry one. */
export function htmlOutline(html: string, remember: (text: string) => void = () => {}): HtmlOutline {
  const doc = parseHtml(html);
  let count = 0;
  let truncated = false;
  const walk = (nodes: Node[], depth: number): HtmlNode[] => {
    const out: HtmlNode[] = [];
    for (const node of nodes) {
      if (node.type === "text") continue;
      if (node.type !== "tag" && node.type !== "script") continue; // comments, directives, <style> (type "style")
      const el = node as Element;
      const name = el.name.toLowerCase();
      if (DROPPED.has(name)) continue;
      if (name === "script") {
        const json = inlineJson(el, remember);
        if (json) out.push(json);
        continue;
      }
      if (name === "head") {
        out.push(...walk(el.children as Node[], depth)); // only its inline JSON survives
        continue;
      }
      if (count >= MAX_NODES || depth > MAX_DEPTH) {
        truncated = true;
        continue;
      }
      count++;
      const own: HtmlNode = { tag: name, ...describe(el) };
      for (const child of el.children) {
        if (child.type !== "text") continue;
        const text = (child as { data: string }).data.trim();
        if (!text) continue;
        own.text = true;
        remember(text);
      }
      if (!LEAVES.has(name)) {
        const children = walk(el.children as Node[], depth + 1);
        if (children.length) own.children = children;
      }
      out.push(own);
    }
    return collapse(out);
  };
  const outline = walk(doc.children as Node[], 0);
  // <html><body> wrap every page: start the outline at what is inside them.
  const unwrapped = unwrap(outline);
  return truncated ? { outline: unwrapped, truncated: true } : { outline: unwrapped };
}

function unwrap(nodes: HtmlNode[]): HtmlNode[] {
  return nodes.flatMap((n) => (n.tag === "html" || n.tag === "body") && !n.id && !n.classes ? unwrap(n.children ?? []) : [n]);
}

function describe(el: Element): Omit<HtmlNode, "tag"> {
  const out: Omit<HtmlNode, "tag"> = {};
  const attribs = el.attribs ?? {};
  if (attribs.id !== undefined && attribs.id !== "") out.id = isIdLike(attribs.id) ? ":id" : attribs.id;
  const classes = [...new Set((attribs.class ?? "").split(/\s+/).filter((c) => c && !isIdLike(c)))].sort();
  if (classes.length) out.classes = classes;
  const attrs = Object.keys(attribs)
    .map((a) => a.toLowerCase())
    .filter((a) => a !== "id" && a !== "class" && a !== "style" && !isValueLikeKey(a))
    .sort();
  if (attrs.length) out.attrs = [...new Set(attrs)];
  if ((el.name === "input" || el.name === "script") && attribs.type && SAFE_TYPE.test(attribs.type)) out.type = attribs.type.toLowerCase();
  return out;
}

function inlineJson(el: Element, remember: (text: string) => void): HtmlNode | null {
  const type = (el.attribs?.type ?? "").toLowerCase();
  if (!type.includes("json")) return null;
  const node: HtmlNode = { tag: "script", ...describe(el) };
  try {
    const value: unknown = JSON.parse(DomUtils.textContent(el));
    collectStrings(value, remember);
    node.json = shapeOf(value);
  } catch {
    node.text = true;
  }
  return node;
}

function collectStrings(value: unknown, into: (s: string) => void, depth = 0): void {
  if (depth > 64) return;
  if (typeof value === "string") into(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, into, depth + 1);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, into, depth + 1);
}

/** What makes two siblings one list: tag, classes and type. Ids differ per item (`ev-101`, `ev-102`). */
function signature(n: HtmlNode): string {
  return [n.tag, (n.classes ?? []).join("."), n.type ?? ""].join("|");
}

/** Siblings with the same tag and classes become one node marked `many`, their outlines joined. */
function collapse(nodes: HtmlNode[]): HtmlNode[] {
  const bySig = new Map<string, HtmlNode>();
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const sig = signature(n);
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
    const seen = bySig.get(sig);
    bySig.set(sig, seen ? mergeNode(seen, n) : n);
  }
  return [...bySig].map(([sig, n]) => ((counts.get(sig) ?? 0) > 1 ? { ...n, many: true as const } : n));
}

/** Two observations of one element joined: attribute names and children of both, text when either had it. */
export function mergeNode(a: HtmlNode, b: HtmlNode): HtmlNode {
  const attrs = [...new Set([...(a.attrs ?? []), ...(b.attrs ?? [])])].sort();
  const children = mergeOutlines(a.children ?? [], b.children ?? []);
  const json = mergeOptional(a.json, b.json);
  // One id on every observation is the element's; ids that differ are the items' own (data).
  const id = a.id === b.id ? a.id : a.id !== undefined || b.id !== undefined ? ":id" : undefined;
  return {
    tag: a.tag,
    ...(id !== undefined ? { id } : {}),
    ...(a.classes ? { classes: a.classes } : {}),
    ...(attrs.length ? { attrs } : {}),
    ...(a.type ? { type: a.type } : {}),
    ...(a.text || b.text ? { text: true as const } : {}),
    ...(a.many || b.many ? { many: true as const } : {}),
    ...(json ? { json } : {}),
    ...(children.length ? { children } : {}),
  };
}

/** Two outlines of the same place (two loads of one page) joined node by node. */
export function mergeOutlines(a: HtmlNode[], b: HtmlNode[]): HtmlNode[] {
  const out = [...a];
  for (const n of b) {
    const i = out.findIndex((x) => signature(x) === signature(n));
    if (i === -1) out.push(n);
    else out[i] = mergeNode(out[i]!, n);
  }
  return out;
}

/**
 * The places in a JSON answer that hold HTML strings (Drupal's `/views/ajax` commands, a CMS body
 * field), with the outline of what each held. Paths are written as in a Fingerprint: `[].data`, with
 * keys that carry data as `{}`.
 */
export function htmlInJson(value: unknown, remember: (text: string) => void = () => {}): { path: string; outline: HtmlNode[]; truncated?: true }[] {
  const found = new Map<string, HtmlOutline>();
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > 64 || found.size > 20) return;
    if (typeof v === "string") {
      if (!looksLikeHtml(v)) return;
      const o = htmlOutline(v, remember);
      const seen = found.get(path);
      found.set(path, seen ? { outline: mergeOutlines(seen.outline, o.outline), ...(seen.truncated || o.truncated ? { truncated: true as const } : {}) } : o);
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item, `${path}[]`, depth + 1);
    } else if (v && typeof v === "object") {
      for (const [k, item] of Object.entries(v)) walk(item, path ? `${path}.${isValueLikeKey(k) ? "{}" : k}` : isValueLikeKey(k) ? "{}" : k, depth + 1);
    }
  };
  walk(value, "", 0);
  return [...found].map(([path, o]) => ({ path, ...o }));
}
