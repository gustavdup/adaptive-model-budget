---
name: budget-uninstall
description: Remove the model budget background job and delete all its settings and readings. Run by the user as a slash command.
disable-model-invocation: true
allowed-tools: Bash(node *agent-budget/scripts/budget.mjs*)
---

# Budget uninstall

1. Tell the user what this does:
   - It removes the background job, if one is installed (launchd on macOS, the marked cron line on Linux).
   - It deletes `~/.config/model-budget`, including their settings.
   - It cannot be undone.

   Ask them to confirm with AskUserQuestion. The options are "Yes, remove it" and "Cancel".

2. Only if they confirm, run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/agent-budget/scripts/budget.mjs" uninstall --yes
   ```

3. Show the output. Tell them that to remove the plugin itself, they run `/plugin uninstall model-budget`. Until then, the hook will start a new reading on the next prompt.
