---
name: __PLUGIN__-feedback
description: Files a problem with the __PLUGIN__ plugin as a GitHub issue on __REPO__, after the user approves the text. Use when a __PLUGIN__ CLI exits 3 (drift) or 1 (bug), when the plugin cannot do a Task the user needs (a feature request), or when the user says "report this" about it. Not for exit 2 (input), 4 (session) or 5 (network).
---
<!-- version: 0.1.0 -->

# __PLUGIN__ feedback

A CLI skill in this plugin hit Drift or a bug, or it lacks a Task the user needs. Draft one issue for `__REPO__`, show it to the user, and file it only on a yes. The maintainer's generator picks it up from there.
#@shared The plugin lives in `__PLUGIN_DIR__` of that repo, alongside other plugins, so its issues carry the label `__PLUGIN__` and its releases are tagged `__PREFIX__vX.Y.Z`.

## When to use

| Trigger | Kind | Key |
|---|---|---|
| exit 3, `kind: "drift"` | drift | the envelope's `fingerprint` (one per entry in `drifts` for `check`) |
| exit 1, `kind: "bug"` | bug | the envelope's `fingerprint` (the bug key) |
| the plugin has no command for what the user asked | feature | none |
| the user says "report this" about the plugin | whichever fits | as above |

Exit 2 (input), 4 (session) and 5 (network) never come here: the CLI skill's own table handles them.

## Input

Work only from the error envelope the CLI just printed: `kind`, `message`, `fingerprint`, `diff`, `drifts`, `stack`, `version`, `os`. The CLI keeps site values out of it. Leave the state dirs (`~/.__PLUGIN__/` and `~/.__PLUGIN__-*`) unread, and add nothing from the conversation that names the user, their account, ids, amounts, addresses or tokens. For a feature request, write the Task in plain words with the same rule.

## Steps

### 1. Search for a match

The key must reach `gh` byte for byte: a Fingerprint can hold `$`, quotes or backticks from the site's field names (`$type`, `$values`), which a shell expands inside double quotes. So put it in a variable with a quoted heredoc and use only `"$key"` afterwards, never the key pasted inside double quotes:

```sh
key=$(cat <<'EOF'
<key>
EOF
)
gh issue list --repo __REPO__ --state all --search "\"$key\" in:title" --json number,title,state,labels,closedAt,url
```

#@standalone Feature: list open feature requests and judge by meaning.
#@shared Feature: list the open feature requests for the CLI skill the Task belongs to (the repo holds other plugins' requests too, so search by title) and judge by meaning.

```sh
#@standalone gh issue list --repo __REPO__ --state open --label feature --json number,title,url
#@shared gh issue list --repo __REPO__ --state open --search '"feature: <skill>:" in:title' --json number,title,url
```

GitHub's search is fuzzy: for Drift and bug, a match is only an issue whose title is exactly the title step 3 would write (the Fingerprint, or `bug: <bug key>`). For Drift, also note open issues whose title starts with the same `<plugin>:<skill>:<operation>:` (the same Operation, seen another way, such as by `check` instead of a command); they are not matches, but the body names them (step 3). When `gh` is missing or not logged in, skip the search and go to step 3; step 4 gives the user a link instead.

### 2. Decide what to do

Compare `fixed-in:__PREFIX__vX.Y.Z` labels with the envelope's `version` as semantic versions.
#@shared Other plugins in the repo have their own `fixed-in` labels: ignore every one that does not start with `fixed-in:__PREFIX__v`.
Several matches are normal (a closed issue and the issue filed when it came back), so take the first row that fits, top to bottom:

| Match | Action | Files a new issue |
|---|---|---|
| open issue (if several, the lowest number) | +1 comment: `+1 on <version>, <os>` | no |
| closed, `fixed-in` newer than `version` | tell the user to update the plugin and rerun | no |
| closed, no `fixed-in` label | tell the user a fix is merged and on its way; +1 comment so a stuck release shows | no |
| closed, `fixed-in` at or below `version` | create an issue that links the closed one (it came back) | yes |
| feature request that looks like the same Task | ask the user whether to +1 it instead | only if they say it differs |
| none | create an issue | yes |

With no open match and several closed ones, judge the closed rows by the most recently closed match (`closedAt`), and compare `version` with the highest `fixed-in` label among all of them.

### 3. Draft

| Kind | Title | Label |
|---|---|---|
| drift | the Fingerprint, exactly | `drift` |
| bug | `bug: <bug key>` | `bug` |
| feature | `feature: <skill>: <Task in plain words>` | `feature` |

#@standalone The label lets the maintainer filter the queue; dedup still goes by the exact title (step 1).
#@shared Every issue also gets the label `__PLUGIN__`, so the maintainer can tell it from the other plugins' issues in the repo. The labels filter the queue; dedup still goes by the exact title (step 1).

Body for drift and bug:

````md
**Version:** <version> · **OS:** <os> · **Kind:** <kind>
**Message:** <message>

```json
<diff (drift) or stack (bug) from the envelope, as printed>
```

<"Previously closed as #n." when step 2 links one>
<"Same Operation: #n, #m." when step 1 noted open issues with the same operation prefix>
````

Body for a feature: the Task in plain words, what the user expected the plugin to return or change, the `version` from `<skill> version` and the `os` from `<skill> doctor`.

A `check` envelope with several entries in `drifts` gives one issue per entry, each with its own Fingerprint and diff. Run step 1 for each.

### 4. Ask, then file

Show the user the title, body and the action from step 2 (new issue, +1 or nothing). Say it goes to `__REPO__` on GitHub. File or comment only after a yes; on a correction, show the new text and ask again. Drift is no exception.

```sh
title=$(cat <<'EOF'
<title>
EOF
)
#@standalone gh issue create --repo __REPO__ --title "$title" --label <label> --body-file - <<'EOF'
#@shared gh issue create --repo __REPO__ --title "$title" --label __PLUGIN__ --label <label> --body-file - <<'EOF'
<body>
EOF
gh issue comment <n> --repo __REPO__ --body "+1 on <version>, <os>"
```

Set the title the same byte-exact way as the key in step 1, so the next user's search finds this issue. `<label>` is the one from step 3; if `gh` says a label does not exist (a repo set up before it), file again without that `--label`.

Without `gh`, without a login, or when `gh` is refused permission: give the user a pre-filled link to open instead, with the title, body and label URL-encoded:

```
#@standalone https://github.com/__REPO__/issues/new?title=<title>&body=<body>&labels=<label>
#@shared https://github.com/__REPO__/issues/new?title=<title>&body=<body>&labels=__PLUGIN__,<label>
```

Duplicates filed this way are caught later by the maintainer through the Fingerprint.

### 5. Tell the user

One short message with the issue link, or why nothing was filed. On Drift, the task stops here: answer nothing from raw calls, the browser or guesses.
