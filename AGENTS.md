# AGENTS.md

This repo is **site-cli-creator**: a plugin for coding agents whose skill turns the calls a website's frontend makes into a plugin of compiled Bun CLIs (each also an MCP server) that agents run as the user. The plugin sits at the repo root; this repo also holds its spec and maintainer tooling. Plugins made with it live elsewhere (the maintainer's in hoaj/plugins).

Use the glossary's words exactly: **Task, Capture, Operation, Contract, Effect, Drift, Fingerprint, Starter code, Feedback skill** ([CONTEXT.md](CONTEXT.md)). Avoid the synonyms it lists.

## Where things are

| Path | What |
|---|---|
| `skills/site-cli-creator/` | The generator: `SKILL.md` (a table of contents) and `reference/*.md` (one per mode), `tools/` (Capture, draft-contract, new, add-skill, regen), `starter/` (the Starter code copied into every new plugin), `fixtures/` (a fake site and the expected generated code), `tests/` |
| `skills/site-cli-creator-feedback/` | Files generator problems as issues here |
| `.claude/skills/improve-site-cli-creator/` | The maintainer skill for changing the generator; never ships (Claude Code loads `.claude/` only from the project you work in) |
| `SPEC.md`, `ARCHITECTURE.md` | What the generator does and why (SPEC wins on any conflict); the implementation contract (interfaces, flags, file layout) |
| `.claude-plugin/`, `.cursor-plugin/`, `.github/plugin/` | The plugin's manifests; `.cursor-plugin/marketplace.json` is a Cursor-only marketplace. Claude Code and Copilot install from the `hoaj` marketplace in hoaj/plugins |
| `docs/agents/` | Issue tracker, triage labels and domain-doc conventions |

## What to reach for

- **Any change to the generator** (tools, Starter code, reference docs, fixtures, tests, CI) or an issue labelled `site-cli-creator`: load the `improve-site-cli-creator` skill first. It is the workflow (triage → red test → fix → green gate → cold read → bump → PR) and holds the areas map, the green gate and the bump rules.
- **Making or maintaining a plugin for a site:** that is the `site-cli-creator` skill itself, run in the plugin's repo, not a change to this one.
- **A decision about behaviour:** read the SPEC section first; change SPEC.md in the same PR when a rule changes, and ARCHITECTURE.md when an interface, flag or layout changes.
- **Issues:** GitHub Issues on hoaj/site-cli-creator via `gh` ([docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)); labels in [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

## Rules the code does not show

- **Starter code is copied, never shared.** A fix in `skills/site-cli-creator/starter/` reaches only plugins created after the release; every PR says which existing plugins should port it ("Starter code reach").
- **Starter files are templates.** They hold tokens (`__PLUGIN__`, `__REPO__`, `__PREFIX__` …) and layout lines (`#@shared` / `#@standalone`) that `new` and `add-skill` fill; one Starter serves a plugin in its own repo and one in a shared repo (`new --dir` / `new --into`).
- **Every PR that changes the plugin bumps its version** in the three manifests (users' agents cache plugins by version); `references/bump.md` in the maintainer skill lists the pins.
- **Shapes, never values.** No real site data in the repo, tests, issues or PRs: no names, ids, amounts, tokens, cookies or raw traffic. Tests use the fixture site or values they plant themselves.
- **Windows and Intel Mac exist only in CI.** A change to `install.sh`, `build.ts`, `main.ts`, the Starter workflows or templating is done only when the five-platform matrix is green: `gh workflow run site-cli-creator.yml --ref <branch>`.
- **A green run without Chrome proves little:** the browser, Capture and e2e tests skip without it. Check the skip count.
- **Throwaway scripts** go in `*.tmp.ts` files (gitignored) and are deleted after use.

## Checks

Bun 1.4.3 (as CI), then `bun install --frozen-lockfile` at the root. The green gate (tests, both `tsc` projects, `actionlint`, `shellcheck`) is in the maintainer skill's `references/areas.md`; run `bun test` twice before a PR.
