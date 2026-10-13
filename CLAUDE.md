## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on hoaj/skills (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Maintainer skills

`maintainer-skills/` holds skills for changing this repo's plugins. They never ship to plugin users and load here through `.claude/skills/`. `improve-site-cli-creator` fixes and extends the site-cli-creator generator (issues labelled `site-cli-creator`).
