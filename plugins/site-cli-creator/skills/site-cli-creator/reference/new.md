# Mode: new

Creates a plugin repo from the Starter code, then its first CLI skill. The person running `new` becomes the plugin's **maintainer**: they own the repo, review PRs and run `fix` with their own site account.

A plugin lives in one of two places: the root of **its own repo**, which is also its own marketplace (`--dir`), or the folder `plugins/<plugin>` of a **shared repo** that holds other plugins and one marketplace, such as `hoaj/plugins` (`--into`, see [Into a shared repo](#into-a-shared-repo)). Steps 1–6 are for its own repo.

Done when `main` holds the plugin with at least one CLI skill whose Tasks pass `check --writes`, and the `v0.1.0` release workflow (`<plugin>-v0.1.0` in a shared repo) has started.

## 1. Ask

Ask in one message, with a proposal for each:

| Value | Rule | Example |
|---|---|---|
| plugin name | kebab-case, usually the site's brand | `yousee` |
| repo | `owner/name` on GitHub; public unless the user says otherwise. Or a shared marketplace repo the user already has (`hoaj/plugins`): then follow [Into a shared repo](#into-a-shared-repo) | `hoaj/yousee-plugin` |
| description | one line, what agents can do with it | `Read your Mit YouSee subscription and bills.` |
| maintainer | `gh api user -q .login` | `hoaj` |
| local folder | where to clone the repo | `~/code/yousee-plugin` |

Public is the default, because then users install the binaries over HTTPS with no `gh` and no GitHub account. A public plugin publishes the site's internal API shapes (never values); if the user does not want that for this site, make it private, and every user then needs `gh`, logged in, with read access.

## 2. Repo

If the repo does not exist, create and clone it:

```sh
gh repo create <owner/name> --public --clone --description "<description>"   # clones into ./<name>
```

Use `--private` instead only when the user chose a private repo in step 1.

If it exists, clone it. `new.ts` writes only into a folder that holds nothing but `.git`; if the repo already has files (a README, a licence), ask the user whether to start from a fresh empty repo instead. Then run the admin check from the Prerequisites table. Without `ADMIN`, stop: labels, releases and merges need it.

## 3. Scaffold

```sh
bun <gen>/tools/new.ts --dir <local folder> --plugin <name> --repo <owner/name> --description "<description>" --maintainer <login>
```

Before writing anything it checks the maintainer requirements (SPEC §13): Bun 1.4 or newer, Google Chrome, `gh` installed and logged in, and admin rights on the repo (`gh api repos/<owner/name> --jq .permissions.admin`). When any is missing it writes nothing and prints `{"error": {"message", "unmet": [{requirement, message}]}}` listing every one; tell the user each fix (a repo that does not exist yet: `gh repo create <owner/name> --public --clone`) and run it again. The site account is not checked: ask for it (step 1 of [add-skill.md](add-skill.md)).

It copies the Starter code (manifests, release and CI workflows, bump script, version-sync test, Feedback skill and Deploy skill), writes the marketplace files that make the repo its own marketplace (`.claude-plugin/`, `.cursor-plugin/`, `.github/plugin/` and `.agents/plugins/marketplace.json`, named after the plugin), `generated.json` and `README.md`, and creates the labels `feature`, `drift`, `bug`, `unverified` and `needs-account`. Read its JSON output; on an error, stop and report it (`site-cli-creator-feedback` if it is the tool's fault).

One error is not a stop: when the files were written but a label could not be created, the error says "files were written" and lists the `gh label create` commands in `retry`. The Feedback skill files feature requests with `feature`, Drift with `drift` and bugs with `bug`, `fix` needs `unverified` and `add-task` needs `needs-account`, so run each `retry` command until it succeeds (fix what `gh` says first: login, network, admin rights), then go on with step 4. Do not run `new.ts` again: the folder is no longer empty.

## 4. First CLI skill

Run [add-skill.md](add-skill.md) without its version bump and PR steps: everything ships as `0.1.0`.

## 5. Push

```sh
cd <plugin> && bun install && bun test
git add -A && git commit -m "new: <plugin> 0.1.0" && git push -u origin HEAD:main
```

The push to `main` starts `release.yml`, which tags `v0.1.0` and builds every CLI skill for five targets. Watch it with `gh run watch --repo <owner/name>` and report the result. Until the release exists, a user's `install.sh` says the binary is still being built.

## 6. Hand over

Tell the user:

- how to install the plugin: the commands in the plugin's `README.md`;
- that users report Drift, bugs and missing Tasks through `<plugin>-feedback`, which files issues on the repo;
- that `<plugin>-deploy` puts a CLI skill on a host they control (Railway first) so claude.ai and the phone can use it;
- that issues titled with a Fingerprint or `bug: …` go to `fix`, and `feature: …` issues to `add-task`.

## Into a shared repo

For a repo that already holds other plugins and one marketplace at its root (at least one of `.claude-plugin/marketplace.json`, `.cursor-plugin/marketplace.json`, `.github/plugin/marketplace.json`, `.agents/plugins/marketplace.json`), such as `hoaj/plugins`. The plugin goes to `plugins/<plugin>/`, and from then on that folder is `<plugin>`, the plugin's root, in every mode.

1. **Ask** for the plugin name, description and maintainer as in step 1. The repo is the shared one and the local folder is its clone. The name must be one the repo's marketplace does not list yet.
2. **Clone** it (or `git pull` an existing clone), branch with `git switch -c new/<plugin>`, and run the admin check from step 2: labels, releases and merges need `ADMIN` here too.
3. **Scaffold** with `--into` instead of `--dir`:
   ```sh
   bun <gen>/tools/new.ts --into <clone> --plugin <name> --repo <owner/name> --description "<description>" --maintainer <login>
   ```
   It checks the same requirements as step 3 and prints the same JSON, plus `root` and `marketplaces`. It writes the plugin to `plugins/<plugin>/` with no marketplace of its own, adds one entry `{name, source: "./plugins/<plugin>", description}` to each marketplace file at the root (the rest of each file stays as it was), writes `.github/workflows/<plugin>-ci.yml` and `<plugin>-release.yml` at the root (they run only when `plugins/<plugin>/` or the workflow changes), and records `pluginDir` (`plugins/<plugin>`) and `tagPrefix` (`<plugin>-v`) in the plugin's `generated.json`. Besides the five labels of step 3 it creates the label `<plugin>`, which the Feedback skill adds to every issue it files; a label `retry` works as in step 3. It refuses, and writes nothing, when the root has no marketplace file, a marketplace file already lists the plugin, or `plugins/<plugin>/` or one of its workflows exists.
4. **First CLI skill:** step 4, with `--dir <clone>/plugins/<plugin>`.
5. **Push through a PR**, since other plugins share `main`:
   ```sh
   cd <clone>/plugins/<plugin> && bun install && bun test
   cd <clone> && git add -A && git commit -m "new: <plugin> 0.1.0" && git push -u origin HEAD
   gh pr create --repo <owner/name> --title "new: <plugin> 0.1.0" --body "<Tasks, check result>"
   ```
   `<plugin>-ci.yml` runs on the PR; the maintainer merges. The merge starts `<plugin>-release.yml`, which publishes `<plugin>-v0.1.0` (never marked the repo's "Latest" release). Watch it as in step 5.
6. **Hand over** as in step 6. The plugin's issues are the ones labelled `<plugin>`: `gh issue list --repo <owner/name> --label <plugin>`.
