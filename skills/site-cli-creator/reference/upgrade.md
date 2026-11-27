# Mode: upgrade

Brings a plugin's Starter code (runtime, `install.sh`, `build.ts`, workflows, scripts, Feedback and Deploy skills) up to this generator's version, as a PR the maintainer merges. Use it when the maintainer asks for it, or when a Starter code fix or feature they want (such as the daily drift check, `.github/workflows/drift-check.yml`) came after the plugin was made: `generated.json`'s `generatedWith` is older than this generator's version (`.claude-plugin/plugin.json` two levels above `<gen>`). The site's own code (`site.ts`, `registry.ts`, `operations/`, `commands/`, `lib/`, `captures/`) is never touched.

Done when the PR is open with a minor bump, no conflict marker is left, `bun test` and every skill's `check --writes` passed, and the body states each conflict decision. The maintainer merges; an upgrade never merges itself.

## 1. Branch

From a clean, up-to-date `main` of the plugin's repo (in a shared repo, its root): `git switch -c upgrade/v<this generator's version>`. The tool refuses a checkout with uncommitted changes.

## 2. Run the tool

```sh
bun <gen>/tools/upgrade.ts --dir <plugin>
```

It downloads the Starter code each part of the plugin was copied from, from the generator's version tags on GitHub, and needs network. Offline, `--starters <folder>` reads them from a folder holding one `<X.Y.Z>/` copy of each version's `skills/site-cli-creator/starter/`. It prints `upToDate: true` when there is nothing to do; then stop. A plugin made before the first tag (`v0.10.0`) has no base: it fails, and the port is by hand.

| Field | Meaning | What you do |
|---|---|---|
| `bases.plugin` | the Starter version the plugin's own files came from (`generatedWith`); `approximate` when that version has no tag and the closest one below it was used | nothing; name it in the PR |
| `bases.skills.<skill>` | the version each CLI skill came from: `from: "generated.json"` (add-skill recorded it) or `"closest"` (the version whose Starter code differs least from the skill's files, `linesApart` lines) | nothing; a large `linesApart` means the skill was edited a lot, so read its `merged` files closely |
| `added` | files new in the Starter code, now written | read them; a new workflow or script may need a secret or a label |
| `updated` | files the plugin never changed, now the new Starter file | nothing |
| `merged` | files both sides changed on different lines, merged cleanly | read each diff (`git diff`) |
| `conflicts` | files both sides changed on the same lines: conflict markers are written into them | step 3 |
| `removedFromStarter` | files the new Starter code no longer has; kept | delete one only when nothing in the plugin uses it (`grep` its name), and say so |
| `deletedInPlugin` | files the plugin deleted that the Starter code changed; left deleted | name them in the PR |
| `siteTemplateDiff` | how the Starter's own `site.ts` changed (a diff), or null | step 4 |
| `workflowsChanged` | a file under `.github/workflows/` changed | pushing needs a token with the `workflow` scope: `gh auth refresh -s workflow` |
| `compare` | the generator's commits and PRs between the oldest base and this version | read it for why each Starter change was made |

`generated.json` now says `generatedWith: <this version>`, and its per-skill record (`skills`) is gone: every part is at this version.

## 3. Resolve each conflict

A conflict reads:

```
<<<<<<< <plugin>
the plugin's lines
||||||| starter it came from
the lines the Starter code had when the plugin copied it
=======
the lines of this generator's Starter code
>>>>>>> starter v<version>
```

For each one, find out what the plugin's edit was for (`git log -p -- <file>` in the plugin) and why the Starter changed (`compare`). Then:

- **The plugin's edit was a hand port of a Starter fix** (the same bug fixed both ways, often a `fix` PR that offered `site-cli-creator-feedback`): take the Starter's lines.
- **The plugin's edit was its own** (a site-specific tweak): apply the Starter change and keep what the edit was for.
- **You cannot tell what is right:** keep the plugin's lines, and list the file under "Left for the maintainer" in the PR with the Starter change it does not have yet.

A hand port often reaches past its hunk: an import or call that merged cleanly, or a helper file the plugin added for it (its header or `git log` names the generator issue it ported). Once you take the Starter's lines, remove what only the port used, delete a plugin-owned helper file nothing imports any more, point the plugin's own tests for it at the Starter code, and name each in the PR. The typecheck in step 5 finds what is left over.

Before going on, `grep -rn '^<<<<<<< ' <plugin>` must find nothing.

## 4. site.ts

`site.ts` is the site's code and is never merged, but the new runtime (`cli/src/runtime/site.ts`) may expect a field the Starter's `site.ts` gained (`siteTemplateDiff`). For each CLI skill, add what the runtime requires with the value the diff shows as its default, keeping every site value as it is. The typecheck in step 5 names any field still missing.

## 5. Check

For each CLI skill, then the plugin:

```sh
cd <skill>/cli && bun install                       # package.json may pin new dependencies; commit bun.lock
cd <skill>/cli && bun run typecheck
bun <gen>/tools/regen.ts --skill-dir <skill>
cd <skill>/cli && SITE_CLI_NONINTERACTIVE=1 bun src/main.ts check --writes
cd <plugin> && bun test
```

Before `bun test`, run `bun install` in every folder the plugin's CI installs in (the "Install dependencies" step of `.github/workflows/ci.yml`: the plugin root, each `skills/*/cli`, and any other folder of the plugin's own with a `package.json`, such as a `server/`): a folder left uninstalled fails with `Cannot find package`, which is not the upgrade's doing.

A failure the upgrade caused is fixed in this branch. A `check` that fails because of Drift is not the upgrade's: open it as a Drift issue for `fix` and say so in the PR.

## 6. Bump and PR

`cd <plugin> && bun run bump minor`, commit, push, open the PR titled `upgrade: Starter code to site-cli-creator <version>`. Its body lists:

- the `bases` and the `compare` link;
- each conflict and what you decided, and the files left for the maintainer;
- the `added`, `removedFromStarter` and `deletedInPlugin` files, and any `site.ts` field you added;
- the `check` result per skill;
- for a plugin in its own repo that just got `.github/workflows/drift-check.yml`: that it checks every CLI skill each morning, and that a login skill needs its CI session stored first (README: Daily drift check).

Leave it for the maintainer to merge.
