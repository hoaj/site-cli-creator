# Writing Operations, commands and site.ts

How to write the three kinds of AGENT file in a CLI skill. The fixture's files are complete, tested examples of every pattern here; open the one that matches before writing your own:

| Pattern | Fixture file under `<gen>/fixtures/expected/` |
|---|---|
| GraphQL read, variable from the session | `login/operations/getAccount.ts` |
| GraphQL read, variable from another Operation | `login/operations/listSubscriptions.ts` |
| REST read with a query string | `login/operations/listInvoices.ts` |
| REST read with a path param | `login/operations/getInvoice.ts` |
| GraphQL write with `trigger` | `login/operations/addNote.ts` |
| Read command with a boolean flag | `login/commands/subscription-show.ts` |
| Command with a required flag | `login/commands/invoice-show.ts` |
| Write command | `login/commands/note-add.ts` |
| `site.ts` with login and `postLogin` | `login/site.ts` |
| `site.ts` without login, with `bootstrap` | `none/site.ts` |

The fixture's `__ORIGIN__` and other `__TOKENS__` are filled in when it is copied; your files hold real values. `registry.ts` imports every file in `operations/` and `commands/`: run `regen.ts` after adding or renaming one.

## Operations (Contracts)

One file per Operation: `cli/src/operations/<name>.ts`, `export default defineOperation({...})` from `../runtime/operation`.

| Field | Rule |
|---|---|
| `name` | GraphQL: the frontend's `operationName`, unchanged. REST: `"GET /api/invoices/:id"`, with `:name` params filled from `variables`. In a Fingerprint the params are written `{name}`: `shop:shop:GET /api/invoices/{id}:http::404` |
| `effect` | `write` when the call changes the user's data on the site, whatever its method; else `read` |
| `graphql` | the frontend's operation with every selection the command does not read removed; keep its name, arguments and variable definitions |
| `rest` | `{ method, path, query?: (vars) => ({...}), body?: (vars) => ({...}) }`; build the body the Capture shows from `variables` |
| `variables` | every input the call takes, as Zod; a failure is exit 2 (input) and nothing is sent |
| `response` | only the fields the command reads (below) |
| `needs` | where each variable comes from (below) |
| `trigger` | writes only (below) |

Start each file with a one-line comment naming the Capture it came from (`// From captures/<task>/<file>.shape.json.`).

### Cutting `response` down

`draft-contract.ts` drafts every field it saw. Cut it to what the command reads:

- Delete every field the command never reads, so changes to them can never cause Drift. Keep objects as plain `z.object`: unknown keys are stripped, so new fields are harmless.
- Decide nullability per field, because one Capture shows one account. Use `.nullable()` when another customer could have no value (dates, prices, optional relations), `.optional()` when the key itself may be absent. Leave a field required when the command cannot produce its output without it.
- Use `z.string()` over `z.enum([...])` unless the command branches on the value: a new status on the site should not break a command that only prints it.
- GraphQL: keep the `data` wrapper in `response`; the runtime parses the whole body.

### `needs`: the chain

Each variable says where it comes from, so `check` calls read Operations in order with no user input:

```ts
needs: { customerId: { from: "session", key: "customerId" } }                          // an id postLogin stored
needs: { accountId: { from: "getAccount", pick: (r) => r.data.getAccount.id } }        // another Operation's result
needs: { id: { from: "GET /api/invoices", pick: (r) => r.invoices[0]?.id } }           // first item of a list
```

`from` is the other Operation's `name`; `pick` gets its parsed `response`. `key: "account"` means the selected `--account`. A variable only the user can supply (free text, a choice) needs no entry; `check` then skips the Operation and says so.

### Writes and `trigger`

A write Operation also gets `trigger(page)`: Playwright steps that drive the site's own UI up to the moment it sends this request. `check --writes` runs it, intercepts the request, compares its shape with `variables` and aborts it, so nothing is written. Relative URLs resolve against the site's origin. Use label and role locators taken from the page (`getByLabel`, `getByRole`), not CSS classes. A `trigger` that can't find its element is Drift.

## Commands

One file per Task: `cli/src/commands/<noun>-<verb>.ts`, `export default defineCommand({...})` from `../runtime/command`.

- `name` is `<noun> <verb>` in English and matches the file name. `summary` becomes the command's row in SKILL.md.
- `args` is a `z.object`: camelCase keys, kebab-case flags (`invoiceId` is `--invoice-id`), booleans are presence flags. Add `.describe("…")` to each flag; `help` prints it. `--account` and `--confirm` are global: leave them out.
- `uses` lists every Operation `run` calls.
- `run(args, { call, session, account, note })` returns exactly the card's `output`: rename and reshape freely, and the CLI prints it as JSON. `session.ids` holds the chain-root ids, `account` the selected account, `note()` writes progress to stderr.
- Call writes with `call` like reads. Without `--confirm`, `call` stops at the first write and the CLI prints the dry run, so build the write's full variables before calling it.

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

- `startUrl`: the page that leads into the site's login. `hosts`: every host the login flow passes through; a redirect to one means logged out.
- `tokenRequest`: a substring or RegExp of the first request the logged-in frontend makes to its API with an `authorization` header; for cookie-only sites, a path that only answers 2xx when logged in.
- `postLogin` returns ids and nothing else. A post-login response often carries names, national ids, addresses, emails and phone numbers: parse the one field you need with Zod and drop the rest, as `login/site.ts` does.
- `bootstrap` uses plain `fetch` only. A site that needs a real browser or a solved challenge to answer is behind a bot wall: out of scope.
- `readOnlyRequests`: while `check --writes` runs a `trigger`, GET requests pass, and so do non-GET requests to a login host, to `tokenRequest` (login skills), to a declared read Operation, to a `readOnlyRequests` entry, and GraphQL documents whose query text is no mutation. Every other non-GET request is aborted, so an undeclared write never reaches the site. A declared write Operation and a GraphQL mutation that is not a declared read are aborted even when `tokenRequest` or `readOnlyRequests` matches their URL. List a request here only when it changes no data; when a page waits for an aborted POST, its `trigger` times out and `check` reports trigger Drift. Capture's `loginFlow: true` calls usually belong here or in `postLogin`.
- `accounts` labels are what the user recognises (a product name, the last digits of a number), never a full personal identifier.
