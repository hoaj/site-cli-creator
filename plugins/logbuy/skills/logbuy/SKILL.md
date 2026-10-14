---
name: logbuy
description: Use when the user wants an employee-benefit deal from Visma LogBuy (mylogbuy.com), signed in as themselves - finding LogBuy discounts for a product, brand or shop ("is there a LogBuy deal on headphones?"), showing one shop's LogBuy deal in full with its current offer and link, listing LogBuy's deal categories, or browsing the deals in one category. Read-only.
---
<!-- version: 0.4.0 -->

# logbuy

- `bin/logbuy` (`bin/logbuy.exe` on Windows) in this skill's folder is a CLI for https://www.mylogbuy.com; below, `logbuy` means that path. Every command prints exactly one JSON document on stdout; progress goes to stderr.
- Write commands (marked in the table) print a dry run without `--confirm`. Show the user the dry run and get an explicit yes before rerunning with `--confirm`.
- A Task that spans several logins or sites is never one command: chain commands from each CLI skill.
- Session, network and input failures are handled here. Only Drift, bugs and missing Tasks go to the `logbuy-feedback` skill.

## Commands

<!-- commands:start -->
| Command | Flags | Does |
|---|---|---|
| `logbuy category list` |  | The LogBuy deal categories with how many deals each has |
| `logbuy deal browse` | `--category <category>` a category name, as `category list` shows it<br>`--limit <n>` how many deals (default 10) | LogBuy deals in one category, best match first |
| `logbuy deal search` | `--query <query>` what to look for, e.g. a product, brand or shop<br>`--limit <n>` how many deals (default 10) | Find LogBuy deals for a product or shop, best match first |
| `logbuy deal show` | `--shop <shop>` the shop's name, as `deal search` lists it | One shop's LogBuy deal in full: discount, terms, current offer, link |
<!-- commands:end -->

Built-ins: `help` (commands, flags, exit codes as JSON), `check [--op <name>] [--writes]`, `doctor`, `version`, and `login` when the site needs one. Global flags: `--account <id>`, `--confirm`.

Run the command the user's question needs. There is no setup step; recover only on failure.

## When it fails

A failure is `{"error": {"kind", "message", "next", ...}}` with a fixed exit code. Do what `next` says:

| Exit / case | kind | Do |
|---|---|---|
| `bin/logbuy` missing | | Run `bash <this skill's folder>/install.sh` once (Git Bash on Windows), then retry |
| 1 | bug | Tell the user and offer to file it with `logbuy-feedback`, passing the envelope. File only on a yes |
| 2 | input | Fix the flags (see `logbuy help`) |
| 2, error lists accounts | input | Ask the user which account, then pass `--account <id>` on this and later calls |
| 3 | drift | Stop. Offer to file it with `logbuy-feedback`, passing the envelope. File only on a yes |
| 4 | session | Run `logbuy login`; the user signs in in the Chrome window; rerun the command (only skills with `login` exit 4) |
| 5 | network | Tell the user the site isn't responding, and stop |
| The CLI can't do what the user asked | | Offer a feature request with `logbuy-feedback` |
| The user asks whether it works, or a failure looks odd | | Run `logbuy check` and report what it prints |

On Drift the site has changed away from what the CLI understands. Stop the task there. Answer only from what the CLI returns: never work around Drift with `curl`, raw API calls or the browser, because that answer would rest on a response nobody has checked.

## When NOT to use

- Anyone else's LogBuy account.
- Redeeming or activating a deal, cashback, gift cards, e-vouchers, favourites or profile settings: the plugin only reads deals. Give the user the deal's `url` to act on it in the browser.
- Prices and deals in shops outside LogBuy: this covers only LogBuy's own discounts.
- Anything else the Commands table does not list: offer a feature request instead of improvising.
- Bulk scraping or automated polling of the site.
