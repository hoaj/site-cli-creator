# hoaj/skills

Personal agent skills for AI coding agents — installable on **Claude Code**, **Cursor**, and **GitHub Copilot CLI**. This repo is both the marketplace catalog and the plugin source.

## Install

Add the marketplace, then install the plugin.

### Claude Code

```
/plugin marketplace add hoaj/skills
/plugin install hoaj-skills@hoaj-skills
```

### Cursor

Settings → Plugins → Add marketplace → `hoaj/skills`, then install **hoaj-skills**.

### GitHub Copilot CLI

```
copilot plugin marketplace add hoaj/skills
copilot plugin install hoaj-skills
```

## Skills

| Skill | Description |
|-------|-------------|
| [run-remote](./plugins/hoaj-skills/skills/run-remote) | Hand off the current task to Anthropic's cloud as a one-shot remote job |

## Adding a skill

1. Create `plugins/hoaj-skills/skills/<your-skill>/SKILL.md`.
2. Add `"./skills/<your-skill>"` to the `skills` array in each manifest under `plugins/hoaj-skills/` (`.claude-plugin`, `.cursor-plugin`, `.github/plugin`).
3. Add a row to the table above.

## License

MIT
