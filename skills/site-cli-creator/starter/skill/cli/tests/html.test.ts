// HTML Operations (#102): a page (or an HTML fragment, or HTML inside JSON) whose values the Contract
// picks with CSS selectors, then parses with Zod like any other response.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { buildRequest } from "../src/runtime/call";
import { Failure } from "../src/runtime/envelope";
import { extractHtml } from "../src/runtime/html";
import { defineOperation } from "../src/runtime/operation";
import { client, fakeFetch, makeDeps, makeSite, tempHome } from "./helpers";

let home: ReturnType<typeof tempHome>;
beforeEach(() => (home = tempHome()));
afterEach(() => home.cleanup());

async function failure(p: Promise<unknown>): Promise<Failure> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Failure) return e;
    throw e;
  }
  throw new Error("expected a Failure");
}

const htmlResponse = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

// Sloppy server-rendered HTML, as a CGI script writes it: no </li>, no </p>, a <br> between words.
const PAGE = `<!doctype html><html><head><title>Planted Title Value</title>
<script type="application/ld+json">{"@type":"Event","name":"Planted Json Name"}</script></head>
<body><h1 class="heading">Kalender</h1>
<ul class="events">
  <li class="event" data-id="ev-101"><h2 class="title">Koncert <i>i</i> parken</h2><time datetime="2026-12-01">1. dec</time><a href="/event/101">Læs</a><span class="tag">musik</span><span class="tag">gratis</span>
  <li class="event" data-id="ev-102"><h2 class="title">Foredrag</h2><p class="where">Biblioteket<br>Sal 2<p class="extra">x
</ul>
<ul class="empty-list"></ul>
</body></html>`;

describe("extractHtml", () => {
  test("text, attributes, all matches, lists in a container, the item itself, and implicit closes", () => {
    const result = extractHtml(PAGE, {
      heading: "h1.heading",
      missing: ".nowhere",
      events: {
        each: "li.event",
        in: "ul.events",
        fields: {
          id: { css: ":scope", attr: "data-id" },
          title: "h2.title",
          date: { css: "time", attr: "datetime" },
          url: { css: "a", attr: "href" },
          noAttr: { css: "a", attr: "title" },
          tags: { css: ".tag", all: true },
          where: "p.where",
        },
      },
      ld: { css: 'script[type="application/ld+json"]', json: true },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        heading: "Kalender",
        missing: null,
        events: [
          { id: "ev-101", title: "Koncert i parken", date: "2026-12-01", url: "/event/101", noAttr: null, tags: ["musik", "gratis"], where: null },
          // The second <li> is not inside the first, and <p class="where"> ends at the next <p>.
          { id: "ev-102", title: "Foredrag", date: null, url: null, noAttr: null, tags: [], where: "Biblioteket Sal 2" },
        ],
        ld: { "@type": "Event", name: "Planted Json Name" },
      },
    });
  });

  test("the page is parsed as a browser builds it: an open <p> ends at the next <li>, a fragment's <tr> stays a row", () => {
    const page = `<ul class="n"><li class="i"><h3>A</h3><p class="when">x<li class="i"><h3>B</h3><p class="when">y</ul>`;
    expect(extractHtml(page, { items: { each: "li.i", in: "ul.n", fields: { t: "h3", when: "p.when" } } })).toEqual({
      ok: true,
      value: { items: [{ t: "A", when: "x" }, { t: "B", when: "y" }] },
    });
    // An HTML fragment (the HTML inside a JSON answer) is parsed as a fragment, so table rows survive.
    expect(extractHtml(`<tr class="r"><td>1<td>2<tr class="r"><td>3`, { rows: { each: "tr.r", fields: { cells: { css: "td", all: true } } } })).toEqual({
      ok: true,
      value: { rows: [{ cells: ["1", "2"] }, { cells: ["3"] }] },
    });
  });

  test("an empty list in a container that is there is an empty list, not Drift", () => {
    expect(extractHtml(PAGE, { items: { each: "li", in: "ul.empty-list", fields: { t: "a" } } })).toEqual({ ok: true, value: { items: [] } });
  });

  test("a container that is gone is Drift at the list's path, not an empty list", () => {
    expect(extractHtml(PAGE, { events: { each: "li", in: "ol.events", fields: { t: "h2" } } })).toEqual({ ok: false, path: "events", code: "no_match" });
    const nested = extractHtml(PAGE, { events: { each: "li.event", fields: { parts: { each: "b", in: "div.parts", fields: { t: ":scope" } } } } });
    expect(nested).toEqual({ ok: false, path: "events[].parts", code: "no_match" });
  });

  test("inline JSON that no longer parses is Drift; a selector the parser refuses is a Contract bug", () => {
    expect(extractHtml("<script id='s'>{not json</script>", { s: { css: "#s", json: true } })).toEqual({ ok: false, path: "s", code: "invalid_json" });
    expect(() => extractHtml(PAGE, { bad: "li[" })).toThrow(/selector/);
  });
});

const listEvents = defineOperation({
  name: "GET /events",
  effect: "read",
  rest: { method: "GET", path: "/events", query: (v) => ({ "categories[]": v.categories, "dates[min]": v.from }) },
  html: { fields: { events: { each: "li.event", in: "ul.events", fields: { title: "h2.title", date: { css: "time", attr: "datetime" } } } } },
  variables: z.object({ categories: z.array(z.string()), from: z.string().optional() }),
  response: z.object({ events: z.array(z.object({ title: z.string().min(1), date: z.string().nullable() })) }),
});

describe("an HTML Operation through the Client", () => {
  test("asks for HTML, repeats an array query key, and returns the extracted values parsed by Zod", async () => {
    const { fetch, calls } = fakeFetch(() => htmlResponse(PAGE));
    const out = await client(makeSite(), makeDeps(fetch, home.dir).deps).call(listEvents, { categories: ["a", "b c"] });
    expect(out).toEqual({ events: [{ title: "Koncert i parken", date: "2026-12-01" }, { title: "Foredrag", date: null }] });
    expect(calls[0].headers.accept).toMatch(/^text\/html/);
    // Arrays repeat their key, undefined is left out, as in a form body.
    expect(calls[0].url).toBe("https://shop.example.test/events?categories%5B%5D=a&categories%5B%5D=b+c");
  });

  test("a changed layout is Drift with a Fingerprint that names the field, and no page value reaches the envelope", async () => {
    const renamed = PAGE.replace('class="events"', 'class="calendar"');
    const { fetch } = fakeFetch(() => htmlResponse(renamed));
    const f = await failure(client(makeSite(), makeDeps(fetch, home.dir).deps).call(listEvents, { categories: [] }));
    expect(f.kind).toBe("drift");
    expect(f.fingerprint).toBe("acme:shop:GET /events:html:events:no_match");
    const gone = PAGE.replaceAll('class="title"', 'class="name"');
    const { fetch: fetch2 } = fakeFetch(() => htmlResponse(gone));
    const g = await failure(client(makeSite(), makeDeps(fetch2, home.dir).deps).call(listEvents, { categories: [] }));
    expect(g.fingerprint).toBe("acme:shop:GET /events:zod:events[].title:invalid_type");
    for (const e of [f, g]) {
      const text = JSON.stringify({ message: e.message, diff: e.diff, fingerprint: e.fingerprint });
      for (const planted of ["Koncert", "Foredrag", "Biblioteket", "Planted", "2026-12-01"]) expect(text).not.toContain(planted);
    }
  });

  test("a page that now answers JSON is Drift (not_html), never a bug", async () => {
    const { fetch } = fakeFetch(() => new Response(JSON.stringify({ events: [] }), { headers: { "content-type": "application/json" } }));
    const f = await failure(client(makeSite(), makeDeps(fetch, home.dir).deps).call(listEvents, { categories: [] }));
    expect(f.fingerprint).toBe("acme:shop:GET /events:html::not_html");
  });

  test("html.from picks the HTML out of a JSON answer (Drupal's /views/ajax) and keeps asking for JSON", async () => {
    const viewsAjax = defineOperation({
      name: "GET /views/ajax",
      effect: "read",
      rest: { method: "GET", path: "/views/ajax" },
      html: {
        from: (body) => z.array(z.object({ command: z.string(), data: z.unknown().optional() })).parse(body).find((c) => c.command === "insert")?.data,
        fields: { titles: { css: "h2.title", all: true } },
      },
      variables: z.object({}),
      response: z.object({ titles: z.array(z.string()).min(1) }),
    });
    const commands = [{ command: "settings", settings: {} }, { command: "insert", data: PAGE }];
    const { fetch, calls } = fakeFetch(() => new Response(JSON.stringify(commands), { headers: { "content-type": "application/json" } }));
    expect(await client(makeSite(), makeDeps(fetch, home.dir).deps).call(viewsAjax, {})).toEqual({ titles: ["Koncert i parken", "Foredrag"] });
    expect(calls[0].headers.accept).toBe("application/json");
    // The JSON no longer carries the HTML where `from` looks: Drift at `from`, whether from throws or finds nothing.
    for (const body of [[{ command: "settings" }], { unexpected: true }]) {
      const { fetch: f2 } = fakeFetch(() => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
      const f = await failure(client(makeSite(), makeDeps(f2, home.dir).deps).call(viewsAjax, {}));
      expect(f.fingerprint).toBe("acme:shop:GET /views/ajax:html:from:not_html");
    }
  });

  test("an HTML Operation asks for HTML even when the session carries an accept header", () => {
    const r = buildRequest(listEvents, { categories: [] }, { origin: "https://x.test", headers: { Accept: "application/json" } });
    expect(r.headers.accept).toMatch(/^text\/html/);
  });
});
