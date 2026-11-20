---
name: budget-setup
description: Set up or change the model budget (thresholds, model and effort per role, pace, transcript scan, delegation, optional background job). Run by the user as a slash command.
disable-model-invocation: true
allowed-tools: Bash(node *agent-budget/scripts/budget.mjs*)
---

# Budget setup

Walk the user through the model-budget settings. Keep it short. The defaults work without any setup, so "keep the defaults" is always a fine answer. Re-running this edits the existing settings.

The script is: `node "${CLAUDE_PLUGIN_ROOT}/skills/agent-budget/scripts/budget.mjs"`. Below, it is called `budget`.

## Steps

1. Run `budget show` and show the user the output. It has the thresholds, pace, the model and effort tables, and whether the background job is on. On a first run these are the defaults.

2. Ask with AskUserQuestion, one question per item, as multiple choice:
   - **Models.** "Keep these models?" The options are: keep, change some, or all Opus (no Fable). If they want changes, ask which mode and role in plain words. Then build `<mode>.<role>=<model>` pairs. The modes are open, steady, tight, out and exhausted, or `all` for all. The roles are plan, build, review, final_check and mechanical.
   - **Effort.** "Keep the subagent effort levels?" Show the effort table from `budget show`. The options are: keep, one level higher for plan and review, or change some. Build `effort.<mode>.<role>=<level>` pairs, using `all` for every mode when the level is the same. The levels are low, medium, high, xhigh and max.
   - **Pace.** "Move modes by how fast you are using each limit?" The options are: yes (the default) and no. With yes, a limit used fast for the time gone counts one mode tighter, and one used slowly near its reset counts one mode looser. No is `pace=off`.
   - **Transcripts.** Ask only when pace is on: "Learn your weekly rhythm from Claude Code's transcripts on this machine, so pace fits you from day one?" The options are: no (the default) and yes. Say plainly what yes means: once a day, a background check goes through the transcripts in `~/.claude/projects` from the last 35 days. It keeps and uses only the time and token counts of each reply. It never keeps, prints or sends any text, it stores only 42 numbers, and nothing leaves the machine. With no, the rhythm is learnt from the plugin's own readings over 2 to 3 weeks. Yes is `transcripts=on`.
   - **Limits.** "Keep the thresholds (steady 50 %, tight 75 %, out 90 %)?" The options are: keep, a bit earlier (40 / 65 / 85), a bit later (60 / 80 / 95), or custom.
   - **Delegation.** Ask when plan and review should go to subagents:
     - `bigger` (the default): medium and large tasks.
     - `always`: every task.
     - `spawn_only`: only when spawning anyway.
   - **Background job.** "Check usage every 15 minutes in the background, even with no session open?" The options are: no (the default) and yes. Say what each means:
     - With no, the reading refreshes while you work, and after a long break the first prompt shows the fallback until the new reading arrives a few seconds later.
     - With yes, a launchd job (macOS) or a cron line (Linux) is installed.

3. Apply the answers:
   - Run `budget config init` first. It writes every setting out to `~/.config/model-budget/config.json`, keeping any the user already has, so the file is easy to edit by hand later.
   - Run `budget config set KEY=VALUE ...` with only the changed values, all in one call. If it prints an error, fix the values and ask again.
   - "All Opus" means `all.plan=opus all.review=opus all.final_check=none`.
   - Run `budget job on` or `budget job off` to match the job answer. Only run `job on` when the user said yes.

4. Run `budget refresh --force` to prove the usage check works. Show the line it prints.
   - If it failed, show the reason. A common one is "could not find the claude command". The fix is to set `MODEL_BUDGET_CLAUDE` to the full path from `which claude`, in their shell profile or in the `env` section of `~/.claude/settings.json`, then restart Claude Code.

5. End with one line: the settings are saved in `~/.config/model-budget/config.json`, which they can also edit by hand, and the line will appear on every prompt.
