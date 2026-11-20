# Adaptive Model Budget

This is a Claude Code plugin, with the plugin id `model-budget`. It picks a model per role (plan, build, review, final check, mechanical) from how much of the user's Claude plan is left. User guide: [README.md](README.md).

## Layout

```
.claude-plugin/plugin.json        plugin manifest (name: model-budget)
.claude-plugin/marketplace.json   lets teammates add this repo or folder as a marketplace (source "./")
hooks/hooks.json                  UserPromptSubmit -> budget.mjs hook
skills/agent-budget/SKILL.md      the main skill: how to pick models from the Budget line
skills/agent-budget/scripts/
  core.mjs                        pure rules: config merge, modes, roles, the line. No I/O.
  fetch.mjs                       the usage fetch: `claude -p` + one get_usage control request
  job.mjs                         optional launchd (macOS) / cron (Linux) job
  budget.mjs                      the CLI: check, hook, refresh, show, config, job, uninstall
skills/budget, budget-setup, budget-uninstall   user-only slash commands
test/                             node --test, temp folders only
```

The scripts live inside the `agent-budget` skill folder, so the skill also works when it is copied on its own to `~/.claude/skills/`.

## How it fits together

- **One script, one cache.** The hook, the skill and the optional job all run `budget.mjs`. All of them read `~/.config/model-budget/` (`MODEL_BUDGET_DIR` overrides it).
- **Hook.** It prints the line straight away and never blocks. When the reading is over 15 minutes old, it starts `refresh` detached in the background.
- **Refresh.** It takes `refresh.lock`, so sessions never fetch twice at once. After a failed check it waits 5 minutes before trying again.
- **Readings.**
  - Under 45 minutes old: fresh.
  - Older than 45 minutes: stale. Stale and missing readings give the fallback roles, which are the Fable `steady` row plus the weekly `open` row.
  - A window past its reset counts as 0 %.
- **Roles.**
  - The Fable mode drives plan, build, review and final check, unless the weekly mode is tight or worse and further along: then the weekly mode drives them (`fableRoleMode`). The weekly mode always drives mechanical.
  - With no Fable window, Fable counts as `steady`.
- **Pace.** `paceFor` gives the % a window reaches at its reset at the current rate, from the window length in `WINDOW_MIN`. It is worked out at the time of the reading, so an ageing reading keeps its pace. `pacedMode` moves the mode at most one step: tighter at `PACE_TIGHTER` (110 % for 5h, 130 % for the weekly windows) but never past tight, looser under 70 % with half the window gone (never from out or exhausted). It waits until 10 % of the window has gone. `pace: off` turns it off.
- **Effort.** A table per mode and role, like the models, picked by the same modes (`effortFor`). It replaces the old "effort one level lower" advice. The skill uses the line's effort as it is: never lower effort twice.
- **Config.** It is per user, in `~/.config/model-budget/config.json`, and never in the plugin folder, because plugin updates replace that folder. `config init`, `set` and `reset` write every value out, plus `_help` notes, so the file is easy to edit by hand. Keys starting with `_` are ignored. It is merged per mode and per role over `DEFAULT_ROLES`, `DEFAULT_EFFORT` and `DEFAULT_THRESHOLDS`. New top-level settings must be added to `SETTINGS` in `core.mjs`, `applySettings` and `fullConfig`. Bad values fall back to the default, and the line reports the problem. The line is built from the resolved roles, so it always matches the config.
- **The job.** It runs a copy of the scripts in `<dir>/bin`, because the plugin cache path changes on every update. It bakes in absolute `node` and `claude` paths.

## Rules

- **Plain Node 18+ only.** Use ESM `.mjs`, with no dependencies and no build step. No `jq` either.
- **No network except the usage fetch, and Claude Code makes that.**
  - No telemetry. The child process gets `DISABLE_TELEMETRY=1`.
  - Never log or print the raw `get_usage` answer. Keep only the three windows.
- **Isolate the child `claude`.** Keep `--setting-sources ""`, the empty `--mcp-config` and `--no-session-persistence`. These stop the plugin's own hook loading in the child.
- **Clean its environment.** Drop `ANTHROPIC_API_KEY`, `CLAUDECODE` and `CLAUDE_CODE_*`. Do not use `--bare`, because it skips the subscription login.
- **Files.**
  - Write with a temp file and rename.
  - The folder is 0700 and the files are 0600.
  - Cap reads at 16 KB.
- **The hook always exits 0 and prints exactly one line.** Strip control characters, and cap the line at 600 characters.
- **Touch only our own job.** The cron edit changes only lines ending `# model-budget`. The launchd label is `local.model-budget.refresh`.
- **Skill text.** Say "the user", never a name. The user's explicit instruction always wins.
- **Writing style.** UK English, short sentences, no em dashes.

## Work on it

```bash
npm test
```

```bash
claude plugin validate .
```

```bash
claude --plugin-dir .
```

- `claude --plugin-dir .` loads the plugin for one session and changes no settings.
- For a live check that does not touch your real config, set `MODEL_BUDGET_DIR` to a temp folder, then run `node skills/agent-budget/scripts/budget.mjs refresh --force`.
- Tests must use temp folders. They must never install a real launchd or cron job.
- Never install, enable, publish or push without the owner's say-so.
