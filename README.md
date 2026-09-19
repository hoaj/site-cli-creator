# hoaj/skills

Personal agent skills for AI coding agents — installable on **Claude Code**, **Cursor**, and **GitHub Copilot CLI**. This repo is both the marketplace catalog and the plugin source.

## Install

Add the marketplace, then install the plugin.

### Claude Code

```
/plugin marketplace add hoaj/skills
/plugin install bankmcp@hoaj-skills
```

### Cursor

Settings → Plugins → Add marketplace → `hoaj/skills`, then install **bankmcp**.

### GitHub Copilot CLI

```
copilot plugin marketplace add hoaj/skills
copilot plugin install bankmcp
```

## Plugins

| Plugin | Skill | Description |
|--------|-------|-------------|
| [bankmcp](./plugins/bankmcp) | `/bankmcp:setup` | Set up your own BankMCP server (read-only bank access for Claude or ChatGPT), locally or on Railway |

## Adding a plugin

Each plugin is its own folder under `plugins/`; `plugins/bankmcp` is the template.

1. Create `plugins/<plugin>/skills/<skill>/SKILL.md`.
2. Copy the three manifests from `plugins/bankmcp/` (`.claude-plugin`, `.cursor-plugin`, `.github/plugin`), then change `name`, `description` and the `skills` array.
3. Add the plugin to each marketplace (`.claude-plugin/marketplace.json`, `.cursor-plugin/marketplace.json`, `.github/plugin/marketplace.json`) and a row to the table above.

## License

MIT
