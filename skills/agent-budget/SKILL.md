---
name: agent-budget
description: Pick the model (and effort) for subagents from the Budget line, which shows how much of the user's Claude plan is left. Use for any task bigger than a quick fix or a question, and whenever you spawn subagents or split work into plan, build, review, final check or mechanical roles. Also use when the user asks to set up, show or change their model budget.
allowed-tools:
  - Bash(node *agent-budget/scripts/budget.mjs)
  - Bash(node *agent-budget/scripts/budget.mjs")
  - Bash(node *agent-budget/scripts/budget.mjs* show)
  - Bash(node *agent-budget/scripts/budget.mjs* refresh --force)
  - Bash(node *agent-budget/scripts/budget.mjs* config *)
---

# Agent budget

Each prompt carries one Budget line from the model-budget hook, like this:

```
Budget: 5h 20% open (resets in 2h) · week 10% open (resets in 4d4h) · Fable 10% open. Plan fable, build opus, review fable, mechanical sonnet. Bigger tasks: plan and review in subagents on these models.
```

The line already applies the user's settings. Read it and follow it.

**The user's explicit instruction in the session always wins** over the line. If the user names a model, an effort level, or says not to use subagents, do that.

## If there is no Budget line

This happens when the hook is not installed, or when only this skill was copied. Run:

```
node "${CLAUDE_SKILL_DIR}/scripts/budget.mjs"
```

This usually takes a few seconds, and never more than about 30. It refreshes the reading if it is over 15 minutes old and prints the line. If it fails, the line it prints says so and gives the fallback.

## Roles

- **plan**: work out the approach and write the plan.
- **build**: write the code.
- **review**: review the code and the tests.
- **final check**: a short second opinion on a plan or a review. Give it summaries, not whole diffs. Skip it when the line names no final check.
- **mechanical**: search, docs passes, running tests and other gates, simple edits.

## What to do

1. **Decide the task size.**
   - A quick fix, a question, or a read-and-explain is small.
   - Anything that needs a plan or changes several files is bigger.
2. **Delegate as the line says.** The user chooses the delegate setting:
   - "Bigger tasks: plan and review in subagents" (the default): for bigger tasks, spawn a plan subagent on the plan model, then build, then spawn a review subagent on the review model. Do small tasks yourself.
   - "Every task: plan and review in subagents": do the same for every task that changes code.
   - No delegate sentence: only use the models when you spawn subagents anyway.
3. **Build.** For a bigger task that you are delegating, build on the build model: build yourself if you are running on it, otherwise spawn a build subagent on it. Small tasks, and anything under `spawn_only`, you build yourself.
4. **Use the mechanical model** for search, gates and other routine subagents.
5. **Set `model` on every subagent you spawn** to the model the line names for its role. The names are `fable`, `opus`, `sonnet` and `haiku`.
6. **Follow the advice in the line:**
   - "Subagent effort one level lower": set subagent effort one level below what you would choose.
   - "Lowest subagent effort that holds quality": use the lowest effort that still does the job well.
   - "No new parallel fan-outs": do not start several subagents at once. Finish what is running.
   - "5h limit reached": start no new subagents.
7. **Say so if the line and the task disagree.** For example, a risky change while limits are out. Say it in one line and ask the user, rather than spend quietly.
8. **If a request is refused for a usage limit**, use the next model down for that role (fable to opus, opus to sonnet). Say so in one line.

## When the reading is stale or missing

The line then says "Fallback". Use the fallback roles it lists. By default:

- Opus plans and builds.
- Fable reviews.
- Sonnet does mechanical work.

## Setup, show and change

When the user asks for these, run the script with the matching command. Show the output.

```
node "${CLAUDE_SKILL_DIR}/scripts/budget.mjs" show                  # reading, thresholds, role table, job
node "${CLAUDE_SKILL_DIR}/scripts/budget.mjs" config init           # write every setting out to config.json
node "${CLAUDE_SKILL_DIR}/scripts/budget.mjs" config set KEY=VALUE  # change settings, see below
node "${CLAUDE_SKILL_DIR}/scripts/budget.mjs" config reset          # back to the defaults
node "${CLAUDE_SKILL_DIR}/scripts/budget.mjs" refresh --force       # check usage now
node "${CLAUDE_SKILL_DIR}/scripts/budget.mjs" job on|off|status     # optional 15-minute background check; only when the user asks
node "${CLAUDE_SKILL_DIR}/scripts/budget.mjs" uninstall --yes       # only when the user asks and confirms: removes the job and all settings
```

These are the settings keys:

- `thresholds.steady`, `thresholds.tight` and `thresholds.out`: whole numbers from 1 to 99, rising in that order.
- `<mode>.<role>`:
  - The mode is `open`, `steady`, `tight`, `out`, `exhausted`, or `all` for all modes.
  - The role is `plan`, `build`, `review`, `final_check` or `mechanical`.
  - The model is `fable`, `opus`, `sonnet` or `haiku`. `final_check` can also be `none`.
- `delegate`: `bigger`, `always` or `spawn_only`.

For example: `config set open.plan=opus all.mechanical=haiku thresholds.tight=80`.

The settings are the user's own, in `~/.config/model-budget/config.json`. Every value is written out there, so the user can also edit the file by hand.
