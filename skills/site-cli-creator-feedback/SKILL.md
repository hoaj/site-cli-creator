---
name: site-cli-creator-feedback
description: Files a problem with the site-cli-creator generator as a GitHub issue on hoaj/site-cli-creator, after the user approves the text. Use when the Capture tool or another generator tool fails or records wrong shapes, a mode (new, add-skill, add-task, fix) breaks or misleads, a bug in a generated plugin traces back to the Starter code, or the generator's guidance turned out wrong (a bug); or when the generator cannot do what the maintainer needs (a feature request); or when the user says "report this" about site-cli-creator. Not for a generated plugin's own Drift, bugs or feature requests: those go to that plugin's <plugin>-feedback skill.
---

# site-cli-creator feedback

Something in the generator got in the way while building or maintaining a plugin. Write it up and, once the user says yes, open an issue on `hoaj/site-cli-creator` with the label `site-cli-creator`.

**You report; the generator stays as it is.** Leave the tools, Starter code and skills unedited in this skill. A fix idea goes in the body under *Suggestion*.

## When to use

| Situation | Type |
|---|---|
| A tool in `tools/` fails, prints wrong JSON, or a Capture misses or mislabels calls | bug |
| A mode's steps fail or lead somewhere wrong; `SKILL.md` or `reference/` guidance was wrong | bug |
| `fix` found a plugin bug in code that came from `starter/` | bug (Starter code) |
| The generator lacks something the plugin needs (an auth flow, a request kind, a tool flag) | feature |

Route these elsewhere:

- A generated plugin's Drift, bug or missing Task: the plugin's `<plugin>-feedback` skill, on the plugin's repo.
- A site behind a bot wall (Cloudflare challenge, captcha): out of scope for v1; tell the user.
- The maintainer's own setup (no Chrome, `gh` logged out, Bun too old): fix it with the generator's prerequisites check.

## 1. Gather the facts

- **Intent:** what the maintainer was doing, in plain words, and which mode.
- **Where:** the tool and its exact command line, or the `SKILL.md` / `reference/*.md` section followed.
- **Expected and actual:** what should have happened, and the actual output verbatim after redaction.
- **Environment:** the generator version from `.claude-plugin/plugin.json` in the site-cli-creator plugin's root (two folders above this skill's folder), `bun --version`, and the OS (`sw_vers -productVersion` on macOS, else `uname -sr`).
- **Starter code bug:** the file under `starter/`, the bug key or stack frame from the plugin's envelope, and the plugin's `generated.json` `generatedWith`.
- **Feature:** the gap, what was done instead, and why that falls short.

## 2. Redact

`hoaj/site-cli-creator` is public. Before anything leaves the machine:

- Keep shapes, type names, field paths, Operation names, HTTP status codes and Fingerprints.
- Replace site values (names, ids, amounts, addresses, emails, phone numbers), tokens, cookies and header values with `<redacted>`.
- Replace the home directory with `~` and private repo names with `<plugin-repo>` unless the user says they may be named.
- Paste nothing from `~/.site-cli-creator/profile/`, a plugin's state dir or raw traffic.

## 3. Search for a duplicate

```sh
gh issue list --repo hoaj/site-cli-creator --label site-cli-creator --state open --search "<tool or symptom>" --json number,title,url
```

An open match gets a comment with the new facts instead of a new issue (`gh issue comment <n> --repo hoaj/site-cli-creator --body-file -`). When `gh` is missing or not logged in, skip the search.

## 4. Draft, show, file

Title: `<tool or mode>: <concrete symptom>` for a bug, `feature: <missing capability>` for a feature.

```md
## Intent
## Where
## Expected
## Actual
## Environment
## Suggestion
```

For a feature, use *Intent*, *The gap*, *Workaround*, *Environment*, *Suggestion*.

Show the user the title and body, say it will be public on `hoaj/site-cli-creator`, and ask whether to file it. File only on a yes; on a correction, show the new text and ask again.

```sh
gh label create site-cli-creator --repo hoaj/site-cli-creator --description "site-cli-creator generator" --color 5319E7 2>/dev/null || true
gh issue create --repo hoaj/site-cli-creator --label site-cli-creator --title "<title>" --body-file - <<'EOF'
<body>
EOF
```

Without `gh`, or without permission to file: give the user this link with the title and body URL-encoded, plus the plain text to paste.

```
https://github.com/hoaj/site-cli-creator/issues/new?labels=site-cli-creator&title=<title>&body=<body>
```

## 5. Tell the user

The issue link and one line on what was reported. Then return to the plugin work.
