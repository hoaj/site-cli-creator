# Mode: add-task (the Task loop)

Adds one command per Task to an existing CLI skill, reusing its Operations. Triggered by a `feature: <skill>: <Task>` issue or by the maintainer.

Done when every Task is a command that returns the card's output from source, `check --writes` exits 0, and (outside `new` / `add-skill`) the PR is open with a minor bump.

## 1. State the Tasks

From the issue or the user, write each Task in plain words. Turn a vague one into something checkable ("see my latest bill" → which fields, how many bills). Outside `add-skill`, branch: `git switch -c add-task/<slug>`.

If the issue asks for a Task the maintainer's account cannot perform (a product they lack, a role they don't hold), there can be no Capture and no Contract. Close the issue:

```sh
gh issue close <n> --repo <owner/name> --comment "<why the maintainer's account can't perform it; reopen when a maintainer with such an account takes over>"
gh issue edit <n> --repo <owner/name> --add-label needs-account
```

## 2. Capture each Task

Pick a short slug per Task (`subscription-show`) and the page the Task starts from. Then:

```sh
bun <gen>/tools/capture.ts --skill-dir <skill> --task <slug> --url <start page>            # read Task
bun <gen>/tools/capture.ts --skill-dir <skill> --task <slug> --url <start page> --write    # write Task
```

The tool records calls to the origin in `site.ts`; when the site's API lives on another host, pass `--origin <api origin>`, and add `--login-host <host>` (host name, no port) for each login host not yet in `site.ts`. Chrome opens headed on the tool's own profile (`~/.site-cli-creator/profile/`, which keeps cookies between Captures; pass `--profile <empty dir>` to watch a site set its cookies from scratch). Tell the user to sign in if asked, perform the Task exactly once, then close the Task window (the one the tool opened) or press Enter in the terminal. The Capture ends when no window on the site is left: a tab the site opened on its own hosts keeps it going, and windows on other sites (a shop, a PDF) close with the last one, counted in the output's `closedWindows`.

**Running it in the background** (stdin from `/dev/null`, so Enter can't reach it): the Capture ends when the user closes the site's last window. To end it yourself, for example when the user says they are done, send `kill -INT <pid>` (or SIGTERM): it stops cleanly and still writes the Capture (`stoppedBy: "SIGINT"`). The tool prints its pid when it starts and, every 30 seconds while waiting, a `still recording` line with the open windows and the same command. Never kill Chrome's processes instead. `bun <gen>/tools/capture.ts --help` lists every flag.

What goes through:

- **Read Task:** every write is aborted, on every host, except sign-in steps (a token or post-login request, a sign-in form on a login host). Writes on hosts outside the Capture are listed in `blockedElsewhere`: a sign-in host there needs `--login-host`; the site's own API needs `--origin`. `loginHosts` names the hosts the sign-in went through; a hint names those site.ts `login.hosts` still lacks.
- **Write Task (`--write`):** one write goes through for real: the first one after the user's first click, key press or form submit in the page. Writes a page fires on its own while loading (YouSee's `createQuote`) are aborted. Say so before starting, and agree on a harmless write (a setting they can revert). The output's `wrote` names the write that went through; if it is not the Task's write, or `hints` says none went through, capture again with `--write-op <operation>` (its name from the first Capture's aborted writes).
- **A POST that only reads** (a search, a persisted GraphQL query sent as a hash, marked `effectUnknown`) is aborted too, and the page may break. Capture again with `--allow-read <operationName or host/path part>` for each one, once you are sure it changes nothing.

**Without a person at the keyboard** (a remote agent, a test), drive the page with `--script <file.ts> --headless`. The file's default export gets the Playwright `page` after the tool has opened `--url` (and followed its redirects, to a login host too); the Capture stops when it resolves. Use real input (`page.click`, `fill`, `press`, locators), never `element.click()` in `page.evaluate`: `--write` counts only real clicks, key presses and submits.

```ts
export default async (page) => {
  await page.getByLabel("Ny note").fill("check");
  await page.getByRole("button", { name: "Tilføj note" }).click();
  await page.waitForResponse((r) => r.url().includes("/graphql"));
};
```

The Capture lands in `<skill>/captures/<slug>/`: one `<operation>.shape.json` per Operation and `index.json` listing Operations in call order with an effect guess. Shapes hold no values: ids, dotted names and any path segment that matches a value the page sent or received become `:id`, and record keys collapse. Before committing, read the REST paths in `index.json` once: a segment that is still a name, a place or a word the user typed is a value; rename it to `:id` in the shape file and its `operation`. Then commit all of it.

If nothing reached the origin, `capture.ts` exits with an error and leaves any earlier Capture of the Task as it was: check `--url`, `--origin` and that the Task was performed, then run it again.

Recapture when the Task's data never appeared (wrong start page, still loading when the browser closed) or a needed Operation is missing.

**One page, several Tasks.** When a single page loads everything (an account page), every Task's Capture of it holds the same Operations. Capture it once per Task anyway (each Task has its own `captures/<slug>/`, which `fix` re-captures), and let step 3 keep different Operations per Task. An Operation the page calls on its own (a detail call for the first item, with no detail page) counts as captured.

## 3. Filter Operations

Read `index.json` and the shape files. Keep:

- every Operation with a field that appears in the Task's output;
- every Operation that supplies a variable to a kept one (the chain), back to a root that comes from `session` (the ids `postLogin` stored) or a constant;
- for a write Task, the write itself.

Drop everything else: analytics, feature flags, page chrome, prefetches, page loads (`navigation: true`) and writes that fire as a side effect of a read Task.

Operations marked `loginFlow: true` in `index.json` are sign-in steps (a token request, a post-login call, a login host's pages). They are never Operations: they belong in `site.ts`, as `login.tokenRequest` or inside `postLogin` ([contracts.md](contracts.md#sitets)). When the page sends such a POST (or any other non-GET that changes no data) before the Task's data appears, list it in `readOnlyRequests` so `check --writes` lets it through. An Operation marked `effectUnknown: true` is a persisted query: decide its `effect` from what it does. Reuse an existing `operations/<file>.ts` when the Operation is already there; widen its `response` only by the fields this Task reads.

### Next.js sites

A Next.js App Router site sends two kinds of call that can never be Operations:

- **Server actions** (`serverAction: true`): a POST to the page's own path with a `next-action` header and a `text/plain` body. They call the page's server code, and nothing shows whether they write, so a read Capture aborts them and prints `server action aborted` at once. If the page then shows errors, capture again with `--allow-read <its path>`, once you are sure it only reads. Drop them either way.
- **RSC streams** (`rsc: true`): page renders sent as `text/x-component` (`GET /partner/:id?_rsc=…`). They are not JSON, so no Zod Contract can parse them. Drop them.

Keep the plain JSON routes the same page calls (usually `/api/…`). When the data only arrives through a server action or an RSC stream, read the page's JavaScript (the chunk that renders the component, in DevTools' Sources) for the API it calls, and capture a page that calls it, or tell the user the Task has no usable API.

Show the result as two lists, kept and dropped, with a one-line reason per Operation.

## 4. Card

Show one card per Task and wait for the user to accept or edit it. Write nothing before that.

```
Task 1: "see my subscription and price"
  command: subscription show [--all]
  output:  customer: string
           products: [{name: string, status: string, since: date|null, monthlyDKK: number|null}]
           monthlyTotalDKK: number
  uses:    getCustomer → listFtpdProducts   (dropped: 4, with reasons)
  effect:  read
```

`output` is the command's JSON with the nullability you decided. `effect` is `write` if any used Operation writes; a write command prints a dry run unless `--confirm` is passed.

## 5. Generate

For each new Operation, draft its Contract into its file with `--out` (not shell redirection: `--out` refuses to overwrite an existing Contract), then cut it down by hand. The file is `<operationName>.ts` for GraphQL and a verb + noun for REST (`getInvoice.ts`; the draft's `file` suggests one). `--name` is for a GraphQL query the Capture could not name (anonymous or persisted); a REST name is always `METHOD /path`, so leave `--name` out.

```sh
bun <gen>/tools/draft-contract.ts <skill>/captures/<slug>/<operation>.shape.json --out <skill>/cli/src/operations/<file>.ts
```

Write `<skill>/cli/src/commands/<noun>-<verb>.ts`. [contracts.md](contracts.md) has the format, the cutting rules and examples. Then:

```sh
bun <gen>/tools/regen.ts --skill-dir <skill>
cd <skill>/cli && bun run typecheck
cd <skill>/cli && bun src/main.ts <noun> <verb> [flags]        # read Task: compare with the card
cd <skill>/cli && bun src/main.ts <noun> <verb> [flags]        # write Task: must print {"dryRun": true, ...}
cd <skill>/cli && bun src/main.ts check --writes
```

Show the user each read command's output shape against the card, not its values. Run a write with `--confirm` only when the user asks for it and agrees to the change on the site. For a command that takes a user-supplied id, also run it with a made-up id: it must exit 2 (input), not 3.

`check` passes when it exits 0 with `"ok": true`: every Operation `ok` and no `warnings`. `"ok": false` with exit 0 means `warnings` lists an Operation `check` could not cover (a read Operation `regen.ts` or `check` calls never checked needs a `needs` entry for each required variable that fits its schema, a constant `{ value }` included: [contracts.md](contracts.md#needs-the-chain)). On exit 3, the Contract is wrong for this account: fix the field (usually nullability) and rerun.

## 6. Bump and PR

Skip inside `new` and `add-skill`.

```sh
cd <plugin> && bun run bump minor && bun test
git add -A && git commit -m "add-task: <skill>: <noun> <verb>" && git push -u origin HEAD
gh pr create --title "add-task: <skill>: <noun> <verb>" --body "<the card, kept/dropped Operations, check result>

Fixes #<n>"
```

The maintainer merges.
