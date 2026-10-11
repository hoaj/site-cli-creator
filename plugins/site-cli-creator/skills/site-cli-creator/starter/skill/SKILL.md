---
name: __SKILL__
description: Use when the user wants to read or change their own data on __ORIGIN__ through the __SKILL__ CLI. Use the Commands table to see which Tasks it covers.
---
<!-- version: 0.1.0 -->

# __SKILL__

- `bin/__SKILL__` (`bin/__SKILL__.exe` on Windows) in this skill's folder is a CLI for __ORIGIN__; below, `__SKILL__` means that path. Every command prints exactly one JSON document on stdout; progress goes to stderr.
- Write commands (marked in the table) print a dry run without `--confirm`. Show the user the dry run and get an explicit yes before rerunning with `--confirm`.
- A Task that spans several logins or sites is never one command: chain commands from each CLI skill.
- Session, network and input failures are handled here. Only Drift, bugs and missing Tasks go to the `__PLUGIN__-feedback` skill.

## Commands

<!-- commands:start -->
| Command | Flags | Does |
|---|---|---|
<!-- commands:end -->

Built-ins: `help` (commands, flags, exit codes as JSON), `check [--op <name>] [--writes]`, `doctor`, `version`, and `login` when the site needs one. Global flags: `--account <id>`, `--confirm`.

Run the command the user's question needs. There is no setup step; recover only on failure.

## When it fails

A failure is `{"error": {"kind", "message", "next", ...}}` with a fixed exit code. Do what `next` says:

| Exit / case | kind | Do |
|---|---|---|
| `bin/__SKILL__` missing | | Run `bash <this skill's folder>/install.sh` once (Git Bash on Windows), then retry |
| 1 | bug | Tell the user and offer to file it with `__PLUGIN__-feedback`, passing the envelope. File only on a yes |
| 2 | input | Fix the flags (see `__SKILL__ help`) |
| 2, error lists accounts | input | Ask the user which account, then pass `--account <id>` on this and later calls |
| 3 | drift | Stop. Offer to file it with `__PLUGIN__-feedback`, passing the envelope. File only on a yes |
| 4 | session | Run `__SKILL__ login`; the user signs in in the Chrome window; rerun the command (only skills with `login` exit 4) |
| 5 | network | Tell the user the site isn't responding, and stop |
| The CLI can't do what the user asked | | Offer a feature request with `__PLUGIN__-feedback` |
| The user asks whether it works, or a failure looks odd | | Run `__SKILL__ check` and report what it prints |

On Drift the site has changed away from what the CLI understands. Stop the task there. Answer only from what the CLI returns: never work around Drift with `curl`, raw API calls or the browser, because that answer would rest on a response nobody has checked.

## When NOT to use

- Anyone else's account on __ORIGIN__.
- Anything the Commands table does not list: offer a feature request instead of improvising.
- Bulk scraping or automated polling of the site.
