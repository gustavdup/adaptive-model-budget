---
name: agent-budget
description: Pick the model and effort for subagents from the Budget line, which shows how much of the user's Claude plan is left. Use for any task bigger than a quick fix or a question, and whenever you spawn subagents or split work into plan, build, review, final check or mechanical roles. Also use when the user asks to set up, show or change their model budget.
allowed-tools:
  - Bash(node /*/agent-budget/scripts/budget.mjs)
  - Bash(node "/*/agent-budget/scripts/budget.mjs")
  - Bash(node /*/agent-budget/scripts/budget.mjs show)
  - Bash(node "/*/agent-budget/scripts/budget.mjs" show)
  - Bash(node /*/agent-budget/scripts/budget.mjs refresh --force)
  - Bash(node "/*/agent-budget/scripts/budget.mjs" refresh --force)
  - Bash(node /*/agent-budget/scripts/budget.mjs config)
  - Bash(node "/*/agent-budget/scripts/budget.mjs" config)
  - Bash(node /*/agent-budget/scripts/budget.mjs config show)
  - Bash(node "/*/agent-budget/scripts/budget.mjs" config show)
---

# Agent budget

Each prompt carries one Budget line from the model-budget hook, like this:

```
Budget: 5h 20% open (resets in 2h) · week 10% open (resets in 4d4h) · Fable 10% open. Plan fable high, build opus medium, review fable high, mechanical sonnet low. Medium and large tasks: review in a subagent; for large ones, plan on the plan model first.
```

Each role has a model and then an effort level for its subagents. The line already applies the user's settings, how fast each limit is being used, and the time left before it resets. "On pace for 140%" means the window would reach 140 % at its reset at this rate, so its mode was moved. Once there is enough history, pace follows the user's own weekly rhythm. "Heavy day" or "Quiet day" means today is far from the user's usual by this time; the modes already allow for it. Read the line and follow it.

**The user's explicit instruction in the session always wins** over the line. If the user names a model, an effort level, or says not to use subagents, do that.

## If there is no Budget line

This happens when the hook is not installed, or when only this skill was copied. Run:

```
node "${CLAUDE_SKILL_DIR}/scripts/budget.mjs"
```

This usually takes a few seconds, and at most about a minute. It refreshes the reading if it is over 15 minutes old and prints the line. If it fails, the line it prints says so and gives the fallback.

## Roles

- **plan**: work out the approach and write the plan.
- **build**: write the code.
- **review**: review the code and the tests.
- **final check**: one short second opinion at the end of a large task, on the plan and the review together. One subagent call, given summaries, not whole diffs. Skip it when the line names no final check.
- **mechanical**: search, docs passes, running tests and other gates, simple edits.

## What to do

1. **Decide the task size.**
   - **Small**: a quick fix, a question, or a read-and-explain.
   - **Medium**: one area, a few files, and a clear approach.
   - **Large**: a new feature, many files, a risky change, or an approach that still needs working out.
2. **Delegate as the line says.** The user chooses the delegate setting:
   - "Medium and large tasks: review in a subagent; for large ones, plan on the plan model first" (the default, `bigger`):
     - Small: do it yourself, with no subagents.
     - Medium: build yourself, then spawn a review subagent on the review model. Skip the plan subagent and the final check.
     - Large: plan on the plan model, then build, then spawn a review subagent on the review model. Then one final check, if the line names one.
   - "Every task: plan on the plan model, then review in a subagent": treat every task that changes code as large.
   - No delegate sentence: only use the models when you spawn subagents anyway.
3. **Plan and build.**
   - Small and medium tasks, and anything under `spawn_only`: build yourself, on whatever model you run on. The user picked that model.
   - Large tasks: plan on the plan model and build on the build model. Do each yourself when you are running on that model, otherwise spawn a subagent on it.
   - Review always goes to a subagent when the line asks for one, even on the same model: fresh eyes are the point.
4. **Use the mechanical model** for search, gates and other routine subagents.
5. **Set `model` and `effort` on every subagent you spawn** to what the line names for its role. The models are `fable`, `opus`, `sonnet` and `haiku`. The effort levels are `low`, `medium`, `high`, `xhigh` and `max`. This skill is the instruction to set effort. Spawn a fresh subagent, not a fork: a fork runs on your own model and ignores `model`.
6. **Follow the advice in the line.** It comes after the delegate sentence and limits it:
   - "No new parallel fan-outs": do not start several subagents at once. One at a time is fine.
   - "5h nearly out": finish what is running. Start at most the one review subagent the task needs. No plan, build, final check or mechanical subagents: do that work yourself.
   - "5h limit reached": start no new subagents.
7. **Say so if the line and the task disagree.** For example, a risky change while limits are out. Say it in one line and ask the user, rather than spend quietly.
8. **Pass problems on.** When the line says to tell the user (settings problems, or checks that keep failing), or the script you ran says "Could not update the reading", tell the user once in one line, and offer to show the model budget: `/model-budget:budget` with the plugin, or the `show` command below with the skill alone. Only the model sees the line, so the user does not know otherwise. Do not repeat it on every prompt. One failed check with no instruction to tell needs no word: the next check usually works.
9. **If a request is refused for a usage limit**, use the next model down for that role (fable to opus, opus to sonnet). Say so in one line.

## When the reading is stale or missing

The line then says "Fallback". Use the fallback roles and effort it lists. By default:

- Opus plans (high) and builds (medium).
- Fable reviews (high).
- Sonnet does mechanical work (low).

When the last reading was already tight, and its window has not reset, the fallback is that tighter row instead. The line has already picked it.

## Setup, show and change

When the user asks for these, run the script with the matching command. Show the output. Changing settings (`config set`, `init`, `reset`) asks the user for permission first: that is on purpose, because the settings are theirs.

```
node "${CLAUDE_SKILL_DIR}/scripts/budget.mjs" show                  # reading, pace, thresholds, model and effort tables, job
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
- `effort.<mode>.<role>`: the same modes and roles, with `low`, `medium`, `high`, `xhigh` or `max`.
- `delegate`: `bigger`, `always` or `spawn_only`.
- `pace`: `on` or `off`.
- `transcripts`: `off` or `on`. On lets a background check learn the user's weekly rhythm from Claude Code's transcripts (times and token counts only). Only turn it on when the user asks.

For example: `config set open.plan=opus all.mechanical=haiku effort.all.build=high thresholds.tight=80`.

The settings are the user's own, in `~/.config/model-budget/config.json`. Every value is written out there, so the user can also edit the file by hand.
