## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on hoaj/site-cli-creator (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Maintainer skills

`.claude/skills/` holds skills for changing the generator, which is the plugin at the repo root. Claude Code never loads `.claude/` from an installed plugin, so they never ship to plugin users. `improve-site-cli-creator` fixes and extends the site-cli-creator generator (issues labelled `site-cli-creator`). The maintainer's own plugins, made with the generator, live in hoaj/plugins.
