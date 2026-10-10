---
name: __PLUGIN__-feedback
description: Files a problem with the __PLUGIN__ plugin as a GitHub issue on __REPO__, after the user approves the text. Use when a __PLUGIN__ CLI exits 3 (drift) or 1 (bug), when the plugin cannot do a Task the user needs (a feature request), or when the user says "report this" about it. Not for exit 2 (input), 4 (session) or 5 (network).
---
<!-- version: 0.1.0 -->

# __PLUGIN__ feedback

A CLI skill in this plugin hit Drift or a bug, or it lacks a Task the user needs. Draft one issue for `__REPO__`, show it to the user, and file it only on a yes. The maintainer's generator picks it up from there.

## When to use

| Trigger | Kind | Key |
|---|---|---|
| exit 3, `kind: "drift"` | drift | the envelope's `fingerprint` (one per entry in `drifts` for `check`) |
| exit 1, `kind: "bug"` | bug | the envelope's `fingerprint` (the bug key) |
| the plugin has no command for what the user asked | feature | none |
| the user says "report this" about the plugin | whichever fits | as above |

Exit 2 (input), 4 (session) and 5 (network) never come here: the CLI skill's own table handles them.

## Input

Work only from the error envelope the CLI just printed: `kind`, `message`, `fingerprint`, `diff`, `drifts`, `stack`, `version`, `os`. The CLI keeps site values out of it. Leave the state dir (`~/.__PLUGIN__-*`) unread, and add nothing from the conversation that names the user, their account, ids, amounts, addresses or tokens. For a feature request, write the Task in plain words with the same rule.

## Steps

### 1. Search for a match

Drift and bug: search by key across open and closed issues.

```sh
gh issue list --repo __REPO__ --state all --search "\"<key>\" in:title" --json number,title,state,labels,url
```

Feature: list open feature requests and judge by meaning.

```sh
gh issue list --repo __REPO__ --state open --label feature --json number,title,url
```

GitHub's search is fuzzy: for Drift and bug, a match is only an issue whose title is exactly the title step 3 would write (the Fingerprint, or `bug: <bug key>`). When `gh` is missing or not logged in, skip the search and go to step 3; step 4 gives the user a link instead.

### 2. Decide what to do

Compare `fixed-in:vX.Y.Z` labels with the envelope's `version` as semantic versions.

| Match | Action | Files a new issue |
|---|---|---|
| open issue | +1 comment: `+1 on <version>, <os>` | no |
| closed, `fixed-in` newer than `version` | tell the user to update the plugin and rerun | no |
| closed, no `fixed-in` label | tell the user a fix is merged and on its way; +1 comment so a stuck release shows | no |
| closed, `fixed-in` at or below `version` | create an issue that links the closed one (it came back) | yes |
| feature request that looks like the same Task | ask the user whether to +1 it instead | only if they say it differs |
| none | create an issue | yes |

### 3. Draft

| Kind | Title | Label |
|---|---|---|
| drift | the Fingerprint, exactly | none |
| bug | `bug: <bug key>` | none |
| feature | `feature: <skill>: <Task in plain words>` | `feature` |

Body for drift and bug:

````md
**Version:** <version> · **OS:** <os> · **Kind:** <kind>
**Message:** <message>

```json
<diff (drift) or stack (bug) from the envelope, as printed>
```

<"Previously closed as #n." when step 2 links one>
````

Body for a feature: the Task in plain words, what the user expected the plugin to return or change, the `version` from `<skill> version` and the `os` from `<skill> doctor`.

A `check` envelope with several entries in `drifts` gives one issue per entry, each with its own Fingerprint and diff. Run step 1 for each.

### 4. Ask, then file

Show the user the title, body and the action from step 2 (new issue, +1 or nothing). Say it goes to `__REPO__` on GitHub. File or comment only after a yes; on a correction, show the new text and ask again. Drift is no exception.

```sh
gh issue create --repo __REPO__ --title "<title>" [--label feature] --body-file - <<'EOF'
<body>
EOF
gh issue comment <n> --repo __REPO__ --body "+1 on <version>, <os>"
```

Without `gh`, without a login, or when `gh` is refused permission: give the user a pre-filled link to open instead, with the title, body and label URL-encoded:

```
https://github.com/__REPO__/issues/new?title=<title>&body=<body>&labels=feature
```

Drop `&labels=feature` for drift and bug. Duplicates filed this way are caught later by the maintainer through the Fingerprint.

### 5. Tell the user

One short message with the issue link, or why nothing was filed. On Drift, the task stops here: answer nothing from raw calls, the browser or guesses.
