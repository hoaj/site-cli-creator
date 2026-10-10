# Mode: add-skill

Adds `skills/<skill>/` for one site with one login or none. Run it for a new site, or for the same site under a second kind of login (each login is its own CLI skill).

Done when the skill's Tasks pass `check --writes`, and (outside `new`) the PR is open with a minor bump.

## 1. Ask

| Value | Rule | Example |
|---|---|---|
| skill name | kebab-case; the plugin name for the plugin's first skill | `yousee` |
| origin | scheme + host the frontend calls, no path | `https://www.yousee.dk` |
| auth | `login` when the Tasks need the user signed in, else `none` | `login` |
| Tasks | plain words, one per line | "see my subscription and price" |

For `login`, confirm the maintainer's own account can perform every Task.

## 2. Scaffold

Outside `new`, branch first: `git switch -c add-skill/<skill>`.

```sh
bun <gen>/tools/add-skill.ts --dir <plugin> --skill <name> --origin <url> --auth login|none
cd <plugin>/skills/<skill>/cli && bun install
```

## 3. Capture the first Task and confirm `auth`

Run the first Task's Capture (add-task.md step 2). Confirm `auth` from it:

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

Write `login` (with `postLogin`) or `bootstrap`, and `accounts` if one login holds several accounts, as [contracts.md](contracts.md) describes. Then:

```sh
cd <plugin>/skills/<skill>/cli && bun src/main.ts login     # auth: login; the user signs in in Chrome
```

`login` passes when it exits 0 and `session.json` holds the chain-root ids. Inspect it for keys only: `bun -e 'console.log(Object.keys(JSON.parse(await Bun.file(process.env.HOME + "/.<plugin>-<skill>/session.json").text()).ids))'`.

## 5. Tasks

Run [add-task.md](add-task.md) from step 3 for the first Task (its Capture exists), then the full loop for each other Task. All Tasks share this mode's one bump and PR.

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
