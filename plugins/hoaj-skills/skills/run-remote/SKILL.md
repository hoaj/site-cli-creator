---
name: run-remote
description: Use when the user wants to run a task in Anthropic's cloud instead of locally — "run this remotely", "cloud job", "remote task", "hand this off", "run as trigger". Common when the user wants to close their laptop while work continues.
---

# Run Remote

Hand off the current task to Anthropic's cloud. Creates a disabled trigger (never recurs) and immediately runs it — a one-shot cloud job.

**Requires the `RemoteTrigger` tool** (a deferred tool in Claude Code). If `RemoteTrigger` is not in your available tools, tell the user this skill isn't available in their environment.

**This skill vs `/schedule`:** Use `run-remote` for one-shot handoffs ("run this now in the cloud"). Use `/schedule` for recurring jobs on a cron schedule.

The key challenge is that the remote agent starts with zero context. Your job is to distill the current conversation into a self-contained prompt that captures everything the remote agent needs to pick up where you left off.

## Step 0: Load the RemoteTrigger tool

```
ToolSearch select:RemoteTrigger
```

This must happen before any RemoteTrigger calls in the steps below.

## Step 1: Pre-flight checks

Before anything else, verify the code is pushed so the remote agent can access it.

```bash
# Get the repo URL
git remote get-url origin

# Check for uncommitted changes
git status --short

# Check for unpushed commits
git log origin/HEAD..HEAD --oneline
```

If there are uncommitted or unpushed changes, warn the user:
> "The remote agent checks out the latest code from GitHub. You have unpushed changes — want me to commit and push first?"

If `git remote get-url origin` returns an SSH URL (e.g. `git@github.com:org/repo.git`), convert it to HTTPS format: `https://github.com/org/repo`

## Step 2: Craft the handoff prompt

This is the most important step. The remote agent knows nothing about your conversation. Write a prompt that includes:

1. **What to do** — the specific task, with file paths and concrete actions
2. **What's already done** — any completed steps so the agent doesn't redo work
3. **What remains** — the specific work left to do
4. **Decisions made** — any choices or constraints agreed on during the conversation
5. **What to do with results** — commit? create PR? just analyze? Default to "commit but do NOT push" unless the user explicitly asked to push.

Keep it focused and specific. A good handoff prompt reads like a clear ticket — someone picking it up cold should know exactly what to do.

**Example — bad:**
> "Continue working on the refactor we discussed"

**Example — good:**
> "Rename all references to `cognigy-cli-skill-output` to `docs/cognigy-cli` across the repo. Check Python scripts in `.claude/skills/cognigy-cli/scripts/`, markdown files in `.claude/skills/cognigy-cli/references/`, and any other files. Also rename the directory itself if it exists. Commit the changes with a descriptive message. Do NOT push."

## Step 3: Discover the environment

The RemoteTrigger API requires an `environment_id`. Get it from an existing trigger:

```
RemoteTrigger action: "list"
```

Extract `environment_id` from any trigger's `job_config.ccr.environment_id`. If no triggers exist, ask the user — they can find their environment ID at https://claude.ai/code/scheduled.

## Step 4: Create and run

Create the trigger:

```
RemoteTrigger action: "create" body: {
  "name": "<short task description>",
  "cron_expression": "0 0 1 1 *",
  "enabled": false,
  "job_config": {
    "ccr": {
      "environment_id": "<from step 3>",
      "session_context": {
        "model": "claude-opus-4-6",
        "sources": [
          {"git_repository": {"url": "<HTTPS URL from step 1>"}}
        ],
        "allowed_tools": [
          "Bash", "Read", "Write", "Edit", "Glob", "Grep",
          "WebSearch", "WebFetch", "TodoWrite", "TodoRead"
        ]
      },
      "events": [
        {
          "data": {
            "uuid": "<generate a fresh lowercase v4 UUID>",
            "session_id": "",
            "type": "user",
            "parent_tool_use_id": null,
            "message": {
              "content": "<the handoff prompt from step 2>",
              "role": "user"
            }
          }
        }
      ]
    }
  }
}
```

Then immediately run it:

```
RemoteTrigger action: "run" trigger_id: "<id from create response>"
```

## Step 5: Share the link

```
Running in the cloud. Track progress here:
https://claude.ai/code/scheduled/<TRIGGER_ID>
```

Tell the user they can safely close their laptop — the job runs independently.

## Notes

- **Default: commit but do NOT push.** Unless the user explicitly asked to push, always include "Do NOT push" in the handoff prompt. The user reviews and pushes manually after checking the result.
- **`enabled: false`** + `cron_expression: "0 0 1 1 *"` = never fires on schedule. We only run it manually.
- **All standard tools are allowed** so the agent never blocks on approval.
- **Model options:** `claude-opus-4-6` (default, most capable), `claude-sonnet-4-6` (faster, cheaper), `claude-haiku-4-5-20251001` (cheapest).
- **Cannot delete triggers via API.** Direct users to https://claude.ai/code/scheduled to clean up.
- **MCP connectors** must be connected at https://claude.ai/settings/connectors before they can be attached to a trigger.
