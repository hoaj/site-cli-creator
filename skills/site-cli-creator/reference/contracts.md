# Writing Operations, commands and site.ts

How to write the three kinds of AGENT file in a CLI skill. Each section below has a short complete example, and the fixture's files are tested examples of every pattern; open the one that matches when yours differs:

| Pattern | Fixture file under `<gen>/fixtures/expected/` |
|---|---|
| GraphQL read, variable from the session | `login/operations/getAccount.ts` |
| GraphQL read, variable from another Operation | `login/operations/listSubscriptions.ts` |
| REST read with a query string | `login/operations/listInvoices.ts` |
| REST read with a path param | `login/operations/getInvoice.ts` |
| GraphQL write with `trigger` | `login/operations/addNote.ts` |
| Read command with a boolean flag | `login/commands/subscription-show.ts` |
| Command with a required flag the user supplies (an id checked against a list) | `login/commands/invoice-show.ts` |
| Write command | `login/commands/note-add.ts` |
| `site.ts` with login and `postLogin` | `login/site.ts` |
| `site.ts` without login, with `bootstrap` | `none/site.ts` |

The fixture's `__ORIGIN__` and other `__TOKENS__` are filled in when it is copied; your files hold real values. `registry.ts` imports every file in `operations/` and every command in `commands/`: run `regen.ts` after adding or renaming one.

## Runtime facts

- Imports, from a file in `operations/` or `commands/`: `defineOperation` from `../runtime/operation`, `defineCommand` and `inputFailure` from `../runtime/command`, `z` from `zod`. `site.ts` imports `defineSite` from `./runtime/site`.
- `call(op, vars)` validates `vars` with `op.variables`, sends the request with the session's headers, classifies the outcome and returns the **parsed `response`** (the Zod output, typed). A GraphQL response keeps its `data` wrapper.
- A command with no flags has `args: z.object({})`. `--account` and `--confirm` are global: never declare them.
- `inputFailure(message)` ends the command with exit 2 (input). Use it when a value the user gave does not exist; never throw your own errors for that (anything else thrown is a bug, exit 1).
- `trigger(page)` starts on `about:blank` in a fresh page: navigate first (`await page.goto("/")`). Relative URLs resolve against the site's origin.
- In `site.ts` hooks, `ctx.fetch` is plain `fetch`: it adds no headers and keeps no cookie jar. Pass `ctx.headers` (the captured `authorization` and `cookie`) yourself. `ctx.decodeJwt(token)` takes the token with or without `Bearer `.
- There is no cookie jar anywhere: what a call needs (a cookie, a CSRF header) is what `bootstrap` returns in `headers`, or what `login` captured.
- Host names in `login.hosts` (and `capture.ts --login-host`) are host names without scheme or port: `login.example.com`.

## Operations (Contracts)

One file per Operation: `cli/src/operations/<file>.ts`, `export default defineOperation({...})`.

| Field | Rule |
|---|---|
| `name` | GraphQL: the frontend's `operationName`, unchanged. REST: `"GET /api/invoices/:id"`, with `:name` params filled from `variables`. In a Fingerprint the params are written `{name}`: `shop:shop:GET /api/invoices/{id}:http::404` |
| `effect` | `write` when the call changes the user's data on the site, whatever its method; else `read` |
| `graphql` | the frontend's operation with every selection the command does not read removed; keep its name, arguments and variable definitions |
| `rest` | `{ method, path, query?: (vars) => ({...}), body?: (vars) => ({...}), bodyType?: "json" \| "form" }`; build the body the Capture shows from `variables` (below) |
| `variables` | every input the call takes, as Zod; a failure is exit 2 (input) and nothing is sent |
| `response` | only the fields the command reads (below) |
| `needs` | where each variable comes from (below) |
| `trigger` | writes only (below) |

**File names.** GraphQL: `<operationName>.ts`. REST: a camelCase verb + noun, because `METHOD /path` cannot be a file name: `GET /api/invoices` is `listInvoices.ts`, `GET /api/invoices/:id` is `getInvoice.ts`, `POST /api/notes` is `createNote.ts`. `draft-contract.ts` suggests this name in its `file` field; the Contract's `name` stays `METHOD /path` either way.

Start each file with a one-line comment naming the Capture it came from (`// From captures/<task>/<file>.shape.json.`).

```ts
// From captures/invoice-show/GET-api-invoices-id.shape.json.
import { z } from "zod";
import { defineOperation } from "../runtime/operation";

export default defineOperation({
  name: "GET /api/invoices/:id",
  effect: "read",
  rest: { method: "GET", path: "/api/invoices/:id" },
  variables: z.object({ id: z.string().min(1) }),
  response: z.object({ id: z.string(), dueDate: z.string().nullable(), amountDKK: z.number() }),
  needs: { id: { from: "GET /api/invoices", pick: (r) => r.invoices[0]?.id } },
});
```

### REST request bodies

Every body field is a variable of its own, next to the path params and the query: `body: (v) => ({ name: v.name, qty: v.qty })` with `variables: z.object({ orderId, name, qty })`. `check --writes` reads the intercepted request the same way (path params, query and body fields merged into one object) and checks it against `variables`, so a nested `body` variable would be Drift on every check. Only a body that is no object (a JSON array or scalar) is the one variable `body`, sent with `body: (v) => v.body`. `draft-contract.ts` drafts it this way.

`bodyType` says how the body is sent: `"json"` (the default, `application/json`) or `"form"` (`application/x-www-form-urlencoded`, a flat object of strings, numbers, booleans or arrays of them). Keep the one the Capture's request used; the draft sets `"form"` from its content-type. Form values arrive as strings, so their variables are `z.string()`. `check --writes` reads the intercepted body by its content-type, and a page that switches encoding is request Drift (`body_type`).

### Cutting `response` down

`draft-contract.ts` drafts every field it saw, merged over every Capture of the skill that holds the same Operation. Cut it to what the command reads:

- Delete every field the command never reads, so changes to them can never cause Drift. Keep objects as plain `z.object`: unknown keys are stripped, so new fields are harmless.
- Decide nullability per field, because one Capture shows one account. Use `.nullable()` when another customer could have no value (dates, prices, optional relations), `.optional()` when the key itself may be absent. Leave a field required when the command cannot produce its output without it.
- A field seen only as `null` drafts as `z.unknown().nullable() /* TODO … */`: give it a type (usually the type the same field has elsewhere, nullable). Never leave `z.null()` or `z.unknown()` on a field the command reads.
- The draft notes a string's format in a comment (`/* numeric string */`, `/* ISO date string */`): keep it in mind when the command converts the value.
- Use `z.string()` over `z.enum([...])` unless the command branches on the value: a new status on the site should not break a command that only prints it.
- An object keyed by data (ids, emails, phone numbers) is a `z.record(z.string(), …)`. Keep it a record: the runtime writes its keys as `{}` in a Fingerprint, so they never reach an issue.
- GraphQL: keep the `data` wrapper in `response`; the runtime parses the whole body. If the draft's query starts with `# number literals were redacted to 0`, put the real literals (or variables) back and delete that line.

### `needs`: the chain

Each variable says where it comes from, so `check` calls read Operations in order with no user input:

```ts
needs: { customerId: { from: "session", key: "customerId" } }                          // an id postLogin stored
needs: { accountId: { from: "getAccount", pick: (r) => r.data.getAccount.id } }        // another Operation's result
needs: { id: { from: "GET /api/invoices", pick: (r) => r.invoices[0]?.id } }           // first item of a list
needs: { limit: { value: "1" }, sortBy: { value: "BestMatch" } }                       // constants: limit is z.string(), as drafted
```

`from` is the other Operation's `name`; `pick` gets its parsed `response`. `key: "account"` means the selected `--account`. `value` is a constant (any JSON value) for a fixed parameter the command always passes (a page size, a sort order), or a harmless sample for one only the user can supply (a search word, a choice): keep the Contract's `variables` as the site wants them and put check's input here, not in Zod defaults. A constant must fit its variable's schema: `draft-contract` drafts REST query variables as `z.string()` (a query value is text), so a page size is `{ value: "1" }`, not `{ value: 1 }`. To keep a number variable instead, make it `z.coerce.number()` (or `z.number()`) with `{ value: 1 }`, and turn it into a string in `rest.query` (`limit: String(v.limit)`).

Every required variable of a read Operation needs an entry that fits it, or `check` can never call it: it skips the Operation as `never checkable`, lists it in its output's `warnings` and prints `"ok": false` (still exit 0) (`no needs entry for <variable>`, or `the needs entry for <variable> does not fit variables` for a constant the schema rejects), and `regen.ts` prints the same warnings (`warnings` in its JSON). Fix each one before `check`.

### Writes and `trigger`

A write Operation also gets `trigger(page)`: Playwright steps that drive the site's own UI up to the moment it sends this request. `check --writes` runs it, intercepts the request, compares its shape with `variables` and aborts it, so nothing is written. Use label and role locators taken from the page (`getByLabel`, `getByRole`), not CSS classes. A `trigger` that can't find its element is Drift, and the Fingerprint names the locator it waited for.

```ts
// From captures/note-add/addNote.shape.json (the user's one real write).
export default defineOperation({
  name: "addNote",
  effect: "write",
  graphql: `mutation addNote($accountId: ID!, $text: String!) { addNote(accountId: $accountId, text: $text) { id } }`,
  variables: z.object({ accountId: z.string().min(1), text: z.string().min(1).max(500) }),
  response: z.object({ data: z.object({ addNote: z.object({ id: z.string() }) }) }),
  needs: { accountId: { from: "getAccount", pick: (r) => r.data.getAccount.id } },
  trigger: async (page) => {
    await page.goto("/"); // starts on about:blank
    await page.getByLabel("Ny note").fill("check");
    await page.getByRole("button", { name: "Tilføj note" }).click();
  },
});
```

## Commands

One file per Task: `cli/src/commands/<noun>-<verb>.ts`, `export default defineCommand({...})`.

- `name` is `<noun> <verb>` in English and matches the file name. `summary` becomes the command's row in SKILL.md; `regen.ts` marks writes (`**Write.**`) and adds "Dry run unless `--confirm`" itself, so don't say either in `summary`.
- `args` is a `z.object`: camelCase keys, kebab-case flags (`invoiceId` is `--invoice-id`), booleans are presence flags. Add `.describe("…")` to each flag; `help` prints it.
- `uses` lists every Operation `run` calls.
- `run(args, { call, session, account, note })` returns exactly the card's `output`: rename and reshape freely, and the CLI prints it as JSON. `session.ids` holds the chain-root ids, `account` the selected account, `note()` writes progress to stderr.
- Call writes with `call` like reads. Without `--confirm`, `call` stops at the first write and the CLI prints the dry run, so build the write's full variables before calling it.
- **A value the user supplies that names something on the site** (an id, a number): check it against the list Operation before calling the lookup, and end with `inputFailure` when it is not there. A 404 on a known REST path is Drift (exit 3, "stop and file it"); a typo must be exit 2 instead.

```ts
import { z } from "zod";
import { defineCommand, inputFailure } from "../runtime/command";
import getInvoice from "../operations/getInvoice";
import listInvoices from "../operations/listInvoices";

export default defineCommand({
  name: "invoice show",
  summary: "One invoice with its lines",
  args: z.object({ id: z.string().min(1).describe("invoice id, as listed by `invoice list`") }),
  uses: [listInvoices, getInvoice],
  run: async ({ id }, { call, session }) => {
    const { invoices } = await call(listInvoices, { accountId: session.ids.accountId });
    if (!invoices.some((i) => i.id === id)) inputFailure("No invoice with that --id: run `invoice list` to see the ids.");
    const invoice = await call(getInvoice, { id });
    return { id: invoice.id, due: invoice.dueDate, amountDKK: invoice.amountDKK };
  },
});
```

**Shared code between commands** (an output mapper, a URL builder) goes in `cli/src/lib/<name>.ts`, never in `commands/`: `regen.ts` registers only `commands/` files whose default export is a command, and warns about any other file there, and about a command file not named `<noun>-<verb>.ts` after its command (`warnings` in its JSON).

```ts
// cli/src/lib/deals.ts, imported by commands/deal-search.ts as `import { toDeal } from "../lib/deals";`
export const toDeal = (d: { id: string; name: string }) => ({ id: d.id, name: d.name, url: `https://shop.example/deal/${d.id}` });
```

## site.ts

`add-skill.ts` writes `plugin`, `skill`, `repo`, `version`, `generatedWith`, `origin` and `auth`; `regen.ts` sets `needsChrome`. Write the rest from the Capture.

| Hook | When | Returns |
|---|---|---|
| `login` | `auth: "login"` | `{ startUrl, hosts, tokenRequest, timeoutMs, postLogin }` |
| `login.postLogin(ctx)` | after each login and refresh | the chain-root ids that `needs` reads with `from: "session"` |
| `bootstrap(ctx)` | `auth: "none"`, before the first call and after a 401/403 | `{ headers, ids? }`: what every call must send (a cookie, a CSRF token) |
| `accounts(ctx)` | one login holds several accounts | `[{ id, label }]`; with more than one, commands need `--account` |
| `readOnlyRequests` | the pages send non-GET requests that change no data (token refresh, post-login, analytics the page waits for) | a list of URL path substrings or RegExps (a RegExp is tested against the whole URL) |

`ctx` is `{ fetch, origin, headers, ids, decodeJwt, call }`: `headers` holds the captured `authorization` and `cookie`, `ids` what `postLogin` returned, and `call` performs an Operation like a command does.

- `startUrl`: the page that leads into the site's login. `hosts`: every host the login flow passes through (host names, no port); a redirect to one means logged out.
- `tokenRequest`: a substring or RegExp of a request with an `authorization` header that **every** load of the start page sends, even when already signed in: frontends often cache their token, so a token or post-login call seen in the first Capture may never come again. Compare two Captures of the same page and pick one that is in both (usually the API or GraphQL endpoint). For cookie-only sites, a path that only answers 2xx when logged in.
- `postLogin` returns ids and nothing else. Which JWT claims it needs is in the Capture: `request.bearerClaims` in a shape file lists the bearer's claim names and types (never values). A post-login response often carries names, national ids, addresses, emails and phone numbers: parse the one field you need with Zod and drop the rest.
- `bootstrap` uses plain `fetch` only. Which cookie it needs is in the Capture: `responses[].setCookies` names the cookies a response set (the front page, usually), and the API shapes list the request headers that carry it back (`cookie`, `x-csrf-token`). A site that needs a real browser or a solved challenge to answer is behind a bot wall: out of scope.
- `readOnlyRequests`: while `check --writes` runs a `trigger`, GET requests pass, and so do non-GET requests to a login host, to `tokenRequest` (login skills), to a declared read Operation and to a `readOnlyRequests` entry. Every other non-GET request is aborted, so an undeclared write never reaches the site. A declared write Operation is aborted even when one of these rules matches its URL. A GraphQL request (a POST to `graphqlPath`, or a GraphQL document sent anywhere) is decided by its documents alone, never by `tokenRequest` or `readOnlyRequests`: it passes only when every document runs a query (the definition its `operationName` selects, else its only one; a fragment first does not hide a mutation) or is named as a declared read Operation. A persisted query sent as a hash only passes when its `operationName` is a declared read, so declare the page's persisted reads as Operations. List a request here only when it changes no data; when a page waits for an aborted POST, its `trigger` times out and `check` reports trigger Drift. Capture's `loginFlow: true` calls usually belong here or in `postLogin`.
- `accounts` labels are what the user recognises (a product name, the last digits of a number), never a full personal identifier. Only the ids are saved; labels are fetched again when the user must choose.

```ts
// auth "none": the front page sets a csrf_token cookie (setCookies in GET-root.shape.json), and
// every API call sends it back as the cookie and in x-csrf-token (the API shapes' request headers).
bootstrap: async (ctx) => {
  const res = await ctx.fetch(`${ctx.origin}/`, { redirect: "manual" });
  if (!res.ok) throw new Error(`front page answered HTTP ${res.status}`);
  const token = res.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith("csrf_token="))?.slice("csrf_token=".length);
  if (!token) throw new Error("front page set no csrf_token cookie");
  return { headers: { cookie: `csrf_token=${token}`, "x-csrf-token": decodeURIComponent(token) } };
},
```
