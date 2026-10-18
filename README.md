# site-cli-creator

A generator for coding agents (**Claude Code**, **Cursor**, **GitHub Copilot CLI**) that turns the calls a website's frontend makes into a plugin of small CLI skills, with Drift checks and a feedback loop: when the site changes, the plugin notices and, once its user agrees, files an issue on its own repo so the maintainer can fix it.

Every CLI skill it generates also runs as an MCP server, locally (`<skill> mcp`) or hosted for one person (`<skill> mcp --http`).

## Install

site-cli-creator ships through the `hoaj` marketplace in [hoaj/plugins](https://github.com/hoaj/plugins), next to the plugins made with it.

### Claude Code

```
/plugin marketplace add hoaj/plugins
/plugin install site-cli-creator@hoaj
```

### GitHub Copilot CLI

```
copilot plugin marketplace add hoaj/plugins
copilot plugin install site-cli-creator@hoaj
```

### Cursor

Cursor's marketplaces cannot list a plugin from another repo, so this repo has a Cursor marketplace of its own: Settings → Plugins → Add marketplace → `hoaj/site-cli-creator`, then install **site-cli-creator**.

## What is here

| Path | What it is |
|------|------------|
| [site-cli-creator](./plugins/site-cli-creator) | The plugin: the generator skill (`/site-cli-creator:site-cli-creator`, with its Capture tool, Starter code and modes) and `/site-cli-creator:site-cli-creator-feedback`, which files generator problems here |
| [SPEC.md](./SPEC.md) | The build spec: what the generator does and why, linking the issues that decided it |
| [CONTEXT.md](./CONTEXT.md) | The glossary: Task, Capture, Operation, Contract, Drift and the rest |
| [maintainer-skills/](./maintainer-skills) | Skills for changing the generator. They never ship to users; they load in this repo through `.claude/skills/` |

hoaj's plugins, made with the generator, live in [hoaj/plugins](https://github.com/hoaj/plugins), each in its own folder with its own CI, releases (`<plugin>-vX.Y.Z`) and issue label (`new --into`). A plugin can also get a repo of its own (`new --dir`).

## License

MIT
