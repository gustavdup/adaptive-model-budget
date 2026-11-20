---
name: budget
description: Show the current model budget reading, roles and settings. Run by the user as a slash command.
disable-model-invocation: true
allowed-tools:
  - Bash(node /*/agent-budget/scripts/budget.mjs show)
  - Bash(node "/*/agent-budget/scripts/budget.mjs" show)
  - Bash(node /*/agent-budget/scripts/budget.mjs refresh --force)
  - Bash(node "/*/agent-budget/scripts/budget.mjs" refresh --force)
---

# Budget

Run this and show the output to the user as it is, in a code block:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/agent-budget/scripts/budget.mjs" show
```

If the reading is over 15 minutes old, offer to check now. The command for that is `node "${CLAUDE_PLUGIN_ROOT}/skills/agent-budget/scripts/budget.mjs" refresh --force`.

If the output lists config problems, explain each one in one line. Suggest the `config set` fix, or `/model-budget:budget-setup`.
