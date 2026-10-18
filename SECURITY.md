# Security policy

## Reporting a vulnerability

Report it privately: open the [Security tab](https://github.com/hoaj/site-cli-creator/security) and choose **Report a vulnerability**. Do not open a public issue.

Include:

- what the problem is and which part it affects
- the version (`plugins/site-cli-creator/.claude-plugin/plugin.json`)
- steps to reproduce, with shapes and type names only, never real site data, tokens or cookies
- the impact you see

## In scope

- The generator: its tools, SKILL.md and reference docs
- The Starter code copied into new plugins (login, session storage, `mcp --http`, install and release scripts)
- The Capture tool, for example a value that reaches a shape file or the disk

Plugins made with the generator live in their own repos. Report their problems there; report a flaw that comes from the Starter code here.

## Supported versions

The latest version on `main`.
