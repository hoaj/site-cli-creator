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
| [site-cli-creator](./plugins/site-cli-creator) | `/site-cli-creator:site-cli-creator`, `/site-cli-creator:site-cli-creator-feedback` | Turn the calls a website makes into a plugin of CLI skills that coding agents can run, with Drift checks and a feedback loop |
| [logbuy](./plugins/logbuy) | `/logbuy:logbuy`, `/logbuy:logbuy-feedback` | Find deals on Visma LogBuy (mylogbuy.com): search products, show a deal, browse categories. Its CLI binary downloads from this repo's `logbuy-v<version>` releases, so it needs `gh` with access to this repo |

## Adding a plugin

Each plugin is its own folder under `plugins/`; `plugins/bankmcp` is the template.

1. Create `plugins/<plugin>/skills/<skill>/SKILL.md`.
2. Copy the three manifests from `plugins/bankmcp/` (`.claude-plugin`, `.cursor-plugin`, `.github/plugin`), then change `name`, `description` and the `skills` array.
3. Add the plugin to each marketplace (`.claude-plugin/marketplace.json`, `.cursor-plugin/marketplace.json`, `.github/plugin/marketplace.json`) and a row to the table above.

A plugin generated with site-cli-creator (like `plugins/logbuy`) also has its own CI and release workflows, `.github/workflows/<plugin>-ci.yml` and `<plugin>-release.yml`, filtered to its folder. Its releases are tagged `<plugin>-vX.Y.Z`, and its issues carry the label `<plugin>`.

## License

MIT
