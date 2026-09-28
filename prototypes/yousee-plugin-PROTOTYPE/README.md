# PROTOTYPE — generated plugin template (throwaway)

Answers **Template command surface and SKILL.md layout** (hoaj/skills#6) by showing
what cli-skill-creator would emit for Mit YouSee. Not production; delete freely.

## Run it (no login needed)

```sh
cd cli && bun install
PROTO_SCENARIO=ok       bun src/main.ts subscription show   # exit 0
PROTO_SCENARIO=drift    bun src/main.ts subscription show   # exit 3, Zod drift
PROTO_SCENARIO=gqlerror bun src/main.ts subscription show   # exit 3, GraphQL validation drift
PROTO_SCENARIO=session  bun src/main.ts subscription show   # exit 4
PROTO_SCENARIO=network  bun src/main.ts subscription show   # exit 5
bun src/main.ts subscription show --foo                     # exit 2
bun src/main.ts report --last                               # dry run of the last drift
PROTO_SCENARIO=ok bun src/main.ts check                     # chains reads, skips writes
bun src/main.ts help
```

## Who writes what

```
.claude-plugin/ .cursor-plugin/ .codex-plugin/ .github/plugin/   GENERATED  4 manifests, same fields
.github/workflows/release.yml                                  FIXED      tag → cross-compile → release
skills/yousee/SKILL.md                                         GENERATED  frontmatter + command table from `help`
skills/yousee/install.sh                                       FIXED      gh release download → ~/.local/bin
captures/                                                      GENERATED  shape-only Captures, ids redacted
cli/build.ts                                                   FIXED      Bun.build + playwright-core patch
cli/src/main.ts                                                FIXED      help login check report doctor version
cli/src/runtime/*                                              FIXED      call+classify, session, envelope, types
cli/src/site.ts                                                GENERATED  origin, endpoints, login hosts, repo
cli/src/registry.ts                                            GENERATED  static imports of operations + commands
cli/src/operations/<name>.ts                                   AGENT      one Contract per Operation
cli/src/commands/<group>-<verb>.ts                             AGENT      task commands composing Operations
```

## Decisions this prototype embodies

- Task commands (`subscription show`), not one command per Operation.
- stdout is always one JSON document; errors are `{error:{kind,message,fingerprint?,diff?,next}}`.
- Exit codes: 0 ok, 1 bug, 2 input, 3 drift, 4 session, 5 network.
- `report` is a subcommand of every CLI; SKILL.md tells the agent to run `report --last` on exit 3.
- Session cached in `~/.yousee/session.json`; plain `fetch`; Chrome only for login/refresh/`check` writes.
- No CLI framework: routing and flag parsing are ~30 lines in `main.ts`.

## Assumptions to check

- `getCustomer` needs `customerId`, so the chain root is read from the session (JWT claim or post-login body).
- improve stays in the generator plugin (maintainer-only), so the generated plugin ships no maintainer skill.
