# Adaptive Model Budget

`model-budget` is a Claude Code plugin that picks the right model for each job based on how much of your Claude plan is left.

While you have plenty left, Fable plans and reviews and Opus builds. As your limits fill up, it moves work to cheaper models. You get a line like this on every prompt, and Claude follows it:

```
Budget: 5h 20% open (resets in 2h) · week 10% open (resets in 4d4h) · Fable 10% open. Plan fable, build opus, review fable, mechanical sonnet. Bigger tasks: plan and review in subagents on these models.
```

**What you say in a prompt always wins.** For example, "use opus for the review" or "don't use subagents".

## What you need

- Claude Code, signed in with a Claude subscription. An API key login has no plan limits to read.
- Node 18 or later. Check with `node --version`.
- macOS or Linux. Windows is not supported yet.

## Install (2 minutes)

From a git repo:

```bash
claude plugin marketplace add gustavdup/adaptive-model-budget
```

```bash
claude plugin install model-budget@model-budget-marketplace
```

Or from a folder someone shared with you:

```bash
claude plugin marketplace add /path/to/model-budget
```

```bash
claude plugin install model-budget@model-budget-marketplace
```

Then restart Claude Code. That's it. The defaults work without any setup, and the Budget line appears from your first prompt. On the very first prompt it says "no usage reading yet", and by the next prompt it has the real figures.

## Use it

| Do this | To |
|---|---|
| Nothing | Get the Budget line on every prompt. Claude picks subagent models from it. |
| `/model-budget:budget` | See the current reading, your thresholds and the full model table. |
| `/model-budget:budget-setup` | Change models, limits, delegation or the background job. Re-run it any time. |
| `/model-budget:budget-uninstall` | Remove the background job and your settings. |

## How it decides

The line shows each window's percent used, its mode, and the time until it resets. There are three windows: the **5-hour** limit, the **weekly** limit for all models, and the **weekly Fable** limit. Each window has a mode:

| Mode | Used (default) |
|---|---|
| open | under 50 % |
| steady | 50 to 75 % |
| tight | 75 to 90 % |
| out | 90 % or more |
| exhausted | 100 % |

- The **Fable mode** picks the models for plan, build, review and final check.
- The **weekly mode** picks the model for mechanical work: search, tests and simple edits.
- The weekly mode also lowers subagent effort when it is tight or out.
- The **5-hour mode** stops new parallel subagents when it is tight or out.

Default models:

| Mode | Plan | Build | Review | Final check | Mechanical |
|---|---|---|---|---|---|
| open | fable | opus | fable | none | sonnet |
| steady | opus | opus | fable | none | sonnet |
| tight | opus | opus | opus | fable | sonnet |
| out | opus | opus | opus | fable | haiku |
| exhausted | opus | opus | opus | none | haiku |

**Delegation.** The budget can only choose models for subagents. It can't change the model your main session runs on. To get Fable planning and reviewing, Claude hands planning and review to subagents. You choose when:

- `bigger` (the default): for tasks bigger than a quick fix.
- `always`: for every task.
- `spawn_only`: only when Claude spawns subagents anyway.

Tip: run your main session on the build model, which is Opus by default.

**If the reading is old.** A reading more than 45 minutes old is called stale. The line then shows a safe fallback instead: Opus plans and builds, Fable reviews, Sonnet does mechanical work.

## Change models and limits

The easy way is to run `/model-budget:budget-setup` and answer the questions.

Or ask Claude directly, for example "set the model budget so open mode plans with opus". It runs the `config set` command for you:

```
config set open.plan=opus                 # one cell
config set all.mechanical=haiku           # one role in every mode
config set thresholds.tight=80            # move a threshold
config set delegate=always                # plan and review in subagents on every task
config init                               # write every setting out to the file
config reset                              # back to the defaults
```

### Your settings file

Your settings are yours alone. They live in `~/.config/model-budget/config.json` on your own machine, and plugin updates never touch them. Setup writes every value out, so you can also just open the file and edit it:

```json
{
  "_help": ["...short notes on each setting..."],
  "thresholds": { "steady": 50, "tight": 75, "out": 90 },
  "delegate": "bigger",
  "roles": {
    "open":      { "plan": "fable", "build": "opus", "review": "fable", "final_check": "none",  "mechanical": "sonnet" },
    "steady":    { "plan": "opus",  "build": "opus", "review": "fable", "final_check": "none",  "mechanical": "sonnet" },
    "tight":     { "plan": "opus",  "build": "opus", "review": "opus",  "final_check": "fable", "mechanical": "sonnet" },
    "out":       { "plan": "opus",  "build": "opus", "review": "opus",  "final_check": "fable", "mechanical": "haiku" },
    "exhausted": { "plan": "opus",  "build": "opus", "review": "opus",  "final_check": "none",  "mechanical": "haiku" }
  }
}
```

- **The file isn't there yet?** Run `/model-budget:budget-setup` once, or ask Claude to "write out my model budget settings".
- **Changes apply on your next prompt.** There is no restart.
- **A bad value is safe.** It falls back to its default, and the Budget line tells you. Run `/model-budget:budget` to see what is wrong.
- **To go back to the defaults,** delete the file, or ask Claude to reset your model budget.

## Background job (optional, off by default)

Without the job, the reading refreshes in the background while you work, at most every 15 minutes. A reading between 15 and 45 minutes old is still used and the line shows its age. After a longer break, the first prompt shows the fallback, and the real figures are back a few seconds later.

If you want it fresh all the time, turn on the job in `/model-budget:budget-setup`. On macOS it is a launchd job, `local.model-budget.refresh`. On Linux it is one crontab line ending in `# model-budget`. It runs every 15 minutes, and its log is `~/.config/model-budget/run.log`.

After a plugin update, re-run setup and say yes to the job again, so it runs the new version.

## Skill only, no plugin

Copy `skills/agent-budget` to `~/.claude/skills/agent-budget`. There is no hook then, so there is no line on every prompt. Instead, Claude runs the skill's script when it is about to split work into roles, and gets the line that way. To change settings, ask Claude to "show my model budget" or "change my model budget".

## Uninstall

1. Run `/model-budget:budget-uninstall`. This removes the job, if you turned it on, and deletes `~/.config/model-budget`.
2. Run `/plugin uninstall model-budget`.
3. Optionally, run `/plugin marketplace remove model-budget-marketplace`.

## Privacy and safety

- **The plugin's only network use is the usage check, and Claude Code makes it with its own login.** The plugin starts `claude -p` with no prompt and sends one `get_usage` request. That returns the same data `/usage` shows, and it uses no tokens. Like any Claude Code start, the child may make its own start-up calls. Telemetry, error reporting and the auto-updater are turned off for it.
- **No telemetry.** Nothing is sent anywhere else. The plugin never reads, prints or stores a token.
- **Only the three limit figures are kept.** They go in `~/.config/model-budget/limits.json`. The folder is mode 0700 and the files are 0600.
- **The usage check loads almost nothing.** It starts with no user or project settings, hooks, plugins or MCP servers, and it saves no transcript. Settings and hooks your organisation enforces through managed policy still apply.

## Troubleshooting

- **"could not find the claude command"**: set `MODEL_BUDGET_CLAUDE` to the full path from `which claude`. Put it in your shell profile (for example `export MODEL_BUDGET_CLAUDE=/path/to/claude` in `~/.zshrc`) or in the `env` section of `~/.claude/settings.json`. Then restart Claude Code.
- **Your plan has no Fable limit**: the line shows `Fable n/a` and uses the steady row. If you can't use Fable at all, run `config set all.plan=opus all.review=opus all.final_check=none`.
- **"no plan limits for this login"**: you are signed in with an API key. Sign in with your subscription (`/login`).
- **Two Budget lines**: you already have your own budget hook. Turn one of them off.
- **The line never changes**: run `/model-budget:budget` and read "Last check failed".

## For developers

See [CLAUDE.md](CLAUDE.md). Run the tests with `npm test`, or `node --test test/*.test.mjs`. To try the plugin for one session without installing it, run `claude --plugin-dir .`.
