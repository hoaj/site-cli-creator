# Mode: add-skill

Adds `skills/<skill>/` for one site with one login or none. Run it for a new site, or for the same site under a second kind of login (each login is its own CLI skill).

Done when the skill's Tasks pass `check --writes`, and (outside `new`) the PR is open with a minor bump.

## 1. Ask

| Value | Rule | Example |
|---|---|---|
| skill name | kebab-case; the plugin name for the plugin's first skill | `yousee` |
| origin | scheme + host the frontend calls, no path | `https://www.yousee.dk` |
| auth | `login` when the Tasks need the user signed in, else `none` | `login` |
| Tasks | plain words, one per line; or "explore first" when the user can't name them yet ([explore.md](explore.md)) | "see my subscription and price" |

For `login`, confirm the maintainer's own account can perform every Task.

## 2. Scaffold

Outside `new`, branch first: `git switch -c add-skill/<skill>`.

```sh
bun <gen>/tools/add-skill.ts --dir <plugin> --skill <name> --origin <url> --auth login|none
cd <plugin>/skills/<skill>/cli && bun install
```

It also copies the skill's deploy files, `Dockerfile` and `.dockerignore`, which the plugin's Deploy skill (`<plugin>-deploy`, written by `new`, with a guide per host) uses for remote mode. Nothing to fill in by hand.

## 3. Capture the first Task and confirm `auth`

Run the first Task's Capture (add-task.md step 2), or the explore Capture ([explore.md](explore.md) step 1). Confirm `auth` from it:

| Capture shows | auth |
|---|---|
| requests to the site carry an `authorization` header or a session cookie set by a login host | `login` |
| the Task's Operations answer without any login step | `none` |

When the Capture contradicts the answer from step 1, tell the user and scaffold again with the right `--auth`. `add-skill.ts` refuses an existing folder, so keep the Capture aside:

```sh
mv <plugin>/skills/<skill>/captures /tmp/<skill>-captures && rm -rf <plugin>/skills/<skill>
bun <gen>/tools/add-skill.ts --dir <plugin> --skill <name> --origin <url> --auth <the other one>
mv /tmp/<skill>-captures <plugin>/skills/<skill>/captures && cd <plugin>/skills/<skill>/cli && bun install
```

## 4. Fill in `site.ts`

Write `login` (with `postLogin`) or `bootstrap`, and `accounts` if one login holds several accounts, as [contracts.md](contracts.md) describes. The Capture holds what you need: its output's `loginHosts` (also in `captures/<task>/index.json`) names the hosts the sign-in went through, which go in `login.hosts`; `request.bearerClaims` in the shape files lists the claim names `postLogin` can decode from the bearer, `responses[].setCookies` names the cookies a response set (what `bootstrap` must fetch), and the API shapes' request headers show what every call sends back. For `tokenRequest`, pick a request every load of the start page sends: compare the first Task's Capture with another Task's Capture of the same start page (capturing the same `--task` again replaces the first one) and use a request that is in both. In an explore Capture, a request whose `pages` in `index.json` lists every page the user opened is a candidate; a frontend that keeps its token sends it only once, so still compare with a second Capture of the start page (the first Task's, or a write Task's) before choosing.

Then check that it works:

```sh
cd <plugin>/skills/<skill>/cli && bun src/main.ts login --from-profile ~/.site-cli-creator/profile   # auth: login
cd <plugin>/skills/<skill>/cli && bun src/main.ts check     # auth: none with bootstrap, once the first Contract exists
```

- **Sign in once.** The user signed in during the first Capture, on the Capture tool's profile; the CLI has its own profile (`profile/` in its state dir: `~/.<plugin>/` for a skill named after its plugin, else `~/.<plugin>-<skill>/`). `login --from-profile ~/.site-cli-creator/profile` (or the `--profile` you gave `capture.ts`) reads that profile's cookies for the site's hosts and the login hosts in memory, signs in headless with them through the normal `tokenRequest` and `postLogin` path in a Chrome context that keeps nothing on disk, and writes only `session.json`, which remembers that profile: `check --writes` and the CLI's silent refresh sign in from it the same way, in memory, so no second sign-in is needed (the CLI's own profile stays as it was). No Capture may be running on that profile while any of them runs. If it exits 4 (the sign-in was kept outside persistent cookies, or has expired), run plain `login`, and tell the user first that Chrome opens and they must sign in again.
- `login` passes when it exits 0 and `session.json` in the `stateDir` it printed holds the chain-root ids. Inspect it for keys only: `bun -e 'console.log(Object.keys(JSON.parse(await Bun.file("<stateDir>/session.json").text()).ids))'`.
- `auth: none` with `bootstrap`: `check` runs `bootstrap` before the first read, so run it as soon as the first Task's Contract exists (step 5). It passes when it exits 0 and `session.json` in the state dir (`doctor` prints it as `stateDir`) holds only `headers` (`bun -e 'console.log(Object.keys(JSON.parse(await Bun.file("<stateDir>/session.json").text()).headers))'`). Exit 3 with an `auth` Fingerprint means the API still refuses the call: `bootstrap` sends the wrong cookie or header.
- `auth: login`: **does the site refuse a signed-out request?** The CLI knows a sign-in has expired only when the site refuses a call (401, 403, or a redirect to a login host). Send two or three GET paths from the Captures' shape files with no cookie or `authorization` header, ids made up: `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' '<origin><path>'`. All 401, 403 or a redirect to a login host: leave `sessionProbe` out. Any other answer (200, 404, 400): the site serves a signed-out request as an anonymous user, so an expired sign-in would reach the user as empty results, exit 2 or false Drift. Then set `login.sessionProbe` ([contracts.md](contracts.md#sitets)) to a GET the frontend sends that answered 2xx in the Capture and answers 401, 403 or a login redirect to the same `curl`, usually a "who am I" call such as `/api/me`. Once the first Contract exists, `SITE_CLI_NONINTERACTIVE=1 bun src/main.ts check` must still exit 0 signed in (a probe that never answers 2xx exits 4 on every run).
- `auth: login`: **does the sign-in hand out a refresh token?** Look at the Capture's login-flow calls (`loginFlow: true`) for an answer with a `refresh_token` field. If one has it, write `login.refresh` ([contracts.md](contracts.md#sitets)) and check it as described there, so an expired session renews without Chrome.
- **Does the site answer the CLI at all?** Some sites refuse requests that don't come from a browser. The first `check` once the first Contract exists shows it: exit 3 with an `auth` Fingerprint although the sign-in or `bootstrap` just worked, or a `zod` Fingerprint with an empty path (an HTML page where JSON was expected), while the Capture recorded JSON for the same call. Then set `transport: "browser"` ([contracts.md](contracts.md#sitets)) and run `check` again.
- While developing, run commands and `check` with `SITE_CLI_NONINTERACTIVE=1` so an expired login exits 4 at once instead of opening Chrome and waiting up to 10 minutes; run `login` again then.

## 5. Tasks

Run [add-task.md](add-task.md) from step 3 for the first Task (its Capture exists), then the full loop for each other Task. After an explore Capture, run [explore.md](explore.md) steps 2 and 3, then add-task step 5 for each chosen Task. All Tasks share this mode's one bump and PR.

## 6. Description

Rewrite the `description` in `<skill>/SKILL.md` to name the site and the Tasks, starting with "Use when", and the `## When NOT to use` list to name what the skill leaves out (writes it lacks, other people's accounts).

## 7. Bump and PR

Skip inside `new`.

```sh
cd <plugin> && bun run bump minor && bun test
git add -A && git commit -m "add-skill: <skill>" && git push -u origin HEAD
gh pr create --title "add-skill: <skill>" --body "<Tasks, Operations, check result>"
```

The maintainer merges.
