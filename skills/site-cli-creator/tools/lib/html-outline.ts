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

/** The outline of `html`. */
export function htmlOutline(html: string): HtmlOutline {
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
        const json = inlineJson(el);
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
        break;
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

/** Class and id prefixes a CMS puts before a value: WordPress's `category-jazz`, `tag-<slug>`, `author-<name>`. */
const VALUE_PREFIX = /^(category|tag|author|term|postid|post_tag|cat|taxonomy|user|member|profile)[-_](?=.)/i;

/**
 * A name with data in it keeps only its pattern: a record number (`post-123` → `post-:id`; one digit stays,
 * `col-md-6`), or the value after a CMS prefix (`author-jensen` → `author-:id`).
 */
function withoutValues(name: string): string {
  const prefix = VALUE_PREFIX.exec(name);
  if (prefix) return `${prefix[0]}:id`;
  return name.replace(/\d{2,}/g, ":id");
}

/** An id that is a slug of words (a heading's anchor, `mit-foredrag-om-jazz`) is the page's text, not site code. */
function isTextId(id: string): boolean {
  return id.split(/[-_]/).filter(Boolean).length >= 4;
}

function describe(el: Element): Omit<HtmlNode, "tag"> {
  const out: Omit<HtmlNode, "tag"> = {};
  const attribs = el.attribs ?? {};
  if (attribs.id !== undefined && attribs.id !== "") out.id = isIdLike(attribs.id) || isTextId(attribs.id) ? ":id" : withoutValues(attribs.id);
  const classes = [...new Set((attribs.class ?? "").split(/\s+/).filter((c) => c && !isIdLike(c)).map(withoutValues))].sort();
  if (classes.length) out.classes = classes;
  const attrs = Object.keys(attribs)
    .map((a) => a.toLowerCase())
    .filter((a) => a !== "id" && a !== "class" && a !== "style" && !isValueLikeKey(a))
    .sort();
  if (attrs.length) out.attrs = [...new Set(attrs)];
  if ((el.name === "input" || el.name === "script") && attribs.type && SAFE_TYPE.test(attribs.type)) out.type = attribs.type.toLowerCase();
  return out;
}

function inlineJson(el: Element): HtmlNode | null {
  const type = (el.attribs?.type ?? "").toLowerCase();
  if (!type.includes("json")) return null;
  const node: HtmlNode = { tag: "script", ...describe(el) };
  try {
    const value: unknown = JSON.parse(DomUtils.textContent(el));
    node.json = shapeOf(value);
  } catch {
    node.text = true;
  }
  return node;
}

/**
 * What makes two siblings one list: tag, classes, type, and a stable id (`#header` and `#content` are two
 * sections). An id with data in it (`ev-:id`) differs per item, so it does not count.
 */
function signature(n: HtmlNode): string {
  const id = n.id && !n.id.includes(":id") ? n.id : "";
  return [n.tag, (n.classes ?? []).join("."), n.type ?? "", id].join("|");
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

/** Two observations' outlines and `truncated` flags joined (the shape of an HTML body and of an `htmlInJson` entry). */
export function mergeOutlined(a: { outline?: HtmlNode[]; truncated?: true }, b: { outline?: HtmlNode[]; truncated?: true }): { outline?: HtmlNode[]; truncated?: true } {
  const outline = mergeOutlines(a.outline ?? [], b.outline ?? []);
  return { ...(outline.length ? { outline } : {}), ...(a.truncated || b.truncated ? { truncated: true as const } : {}) };
}

/** An outline with something to read in it: an element with text, or inline JSON. A SPA's shell (`<div id="root">`) has neither. */
export function outlineHasData(nodes: HtmlNode[] | undefined): boolean {
  return (nodes ?? []).some((n) => n.text || n.json || outlineHasData(n.children));
}

/**
 * Whether a JSON answer's HTML strings are its data (Drupal's `/views/ajax`, whose JSON is commands around
 * the HTML) rather than one rich-text field of a JSON API: they hold a repeated element or half its text.
 */
export function htmlIsTheData(found: { outline: HtmlNode[] }[], htmlChars: number, jsonChars: number): boolean {
  if (!found.some((e) => outlineHasData(e.outline))) return false;
  return jsonChars > 0 && htmlChars / jsonChars >= 0.5;
}

/** The characters of the HTML strings inside a JSON value. */
export function htmlCharsInJson(value: unknown, depth = 0): number {
  if (depth > 64) return 0;
  if (typeof value === "string") return looksLikeHtml(value) ? value.length : 0;
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + htmlCharsInJson(v, depth + 1), 0);
  if (value && typeof value === "object") return Object.values(value).reduce<number>((n, v) => n + htmlCharsInJson(v, depth + 1), 0);
  return 0;
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
export function htmlInJson(value: unknown): { path: string; outline: HtmlNode[]; truncated?: true }[] {
  const found = new Map<string, HtmlOutline>();
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > 64 || found.size > 20) return;
    if (typeof v === "string") {
      if (!looksLikeHtml(v)) return;
      const o = htmlOutline(v);
      const seen = found.get(path);
      found.set(path, seen ? { outline: [], ...mergeOutlined(seen, o) } : o);
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item, `${path}[]`, depth + 1);
    } else if (v && typeof v === "object") {
      for (const [k, item] of Object.entries(v)) walk(item, path ? `${path}.${isValueLikeKey(k) ? "{}" : k}` : isValueLikeKey(k) ? "{}" : k, depth + 1);
    }
  };
  walk(value, "", 0);
  return [...found].map(([path, o]) => ({ path, ...o }));
}
