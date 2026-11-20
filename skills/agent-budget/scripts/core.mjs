// model-budget: pure rules. No I/O, no network.
// Turns a limits reading (limits.json) and the user's config (config.json) into a mode per window,
// a model per role and the one-line Budget summary. Everything here is a plain function so it can be
// tested without touching the disk.

import { dayCheck, patternPace, patternShares } from "./history.mjs";

/** Matches .claude-plugin/plugin.json. The job's copy of the scripts is refreshed when it differs. */
export const VERSION = "1.2.1";

export const MODES = ["open", "steady", "tight", "out", "exhausted"];
export const MODELS = ["fable", "opus", "sonnet", "haiku"];
/** plan, build, review and final_check follow the Fable mode (or the weekly mode once that is tight or worse); mechanical follows the weekly mode. */
export const ROLES = ["plan", "build", "review", "final_check", "mechanical"];
export const FABLE_ROLES = ["plan", "build", "review", "final_check"];
export const WEEKLY_ROLES = ["mechanical"];
const ROLE_LABEL = { plan: "plan", build: "build", review: "review", final_check: "final check", mechanical: "mechanical" };

export const DEFAULT_THRESHOLDS = Object.freeze({ steady: 50, tight: 75, out: 90 });
/** When the main agent hands planning and review to subagents. */
export const DELEGATE = ["bigger", "always", "spawn_only"];
export const DEFAULT_DELEGATE = "bigger";
export const DEFAULT_ROLES = Object.freeze({
  open: { plan: "fable", build: "opus", review: "fable", final_check: "none", mechanical: "sonnet" },
  steady: { plan: "opus", build: "opus", review: "fable", final_check: "none", mechanical: "sonnet" },
  tight: { plan: "opus", build: "opus", review: "opus", final_check: "fable", mechanical: "sonnet" },
  out: { plan: "opus", build: "opus", review: "opus", final_check: "fable", mechanical: "haiku" },
  exhausted: { plan: "opus", build: "opus", review: "opus", final_check: "none", mechanical: "haiku" },
});

/** Subagent effort levels, lowest first. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** The effort for each role's subagents, picked by the same mode as its model. */
export const DEFAULT_EFFORT = Object.freeze({
  open: { plan: "high", build: "medium", review: "high", final_check: "medium", mechanical: "low" },
  steady: { plan: "high", build: "medium", review: "high", final_check: "medium", mechanical: "low" },
  tight: { plan: "medium", build: "medium", review: "medium", final_check: "medium", mechanical: "low" },
  out: { plan: "medium", build: "low", review: "medium", final_check: "low", mechanical: "low" },
  exhausted: { plan: "low", build: "low", review: "low", final_check: "low", mechanical: "low" },
});

/** Pace: how fast a window is being used, as the % it would reach at its reset at this rate. */
export const PACE = ["on", "off"];
export const DEFAULT_PACE = "on";
/** Window lengths in minutes, to tell how much of a window has gone. */
export const WINDOW_MIN = Object.freeze({ five_hour: 300, seven_day: 7 * 24 * 60, fable: 7 * 24 * 60 });
/** Pace only counts once this share of the window has gone: early on, one busy hour looks like a flood. */
export const PACE_MIN_ELAPSED = 0.1;
/**
 * On pace for this % or more at the reset: one mode tighter. Higher for the weekly windows, because a
 * straight line through the week ignores quiet evenings and weekends.
 */
export const PACE_TIGHTER = Object.freeze({ five_hour: 110, seven_day: 130, fable: 130 });
/** With the user's own pattern, quiet times are already counted, so the weekly bar is the same as 5h. */
export const PACE_TIGHTER_PATTERN = 110;
/** The optional transcript scan, to learn the usage pattern from day one. Off unless the user turns it on. */
export const TRANSCRIPTS = ["off", "on"];
export const DEFAULT_TRANSCRIPTS = "off";
/** On pace for under this %, with at least PACE_LOOSER_ELAPSED of the window gone: one mode looser. */
export const PACE_LOOSER = 70;
export const PACE_LOOSER_ELAPSED = 0.5;

/** A reading older than this is refreshed (by the hook in the background, or by the skill). */
export const REFRESH_AFTER_MS = 15 * 60_000;
/** After a failed check, wait this long before the hook tries again. */
export const RETRY_AFTER_MS = 5 * 60_000;
/** A reading older than this is not trusted: the line says so and the fallback roles apply. */
export const STALE_AFTER_MS = 45 * 60_000;
export const MAX_FILE_BYTES = 16 * 1024;
const MAX_LINE = 600;

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isIso = (v) => typeof v === "string" && v.length <= 64 && !Number.isNaN(Date.parse(v));
const SEVERITIES = ["normal", "warning", "critical"];

// ---------- config ----------

/**
 * The effective config: defaults with every valid value from `raw` on top. Anything invalid is
 * replaced by its default and listed in `problems`, so a typo never breaks the budget.
 */
export function resolveConfig(raw) {
  const problems = [];
  const src = raw == null ? {} : raw;
  if (!isObj(src)) {
    problems.push("config.json is not a JSON object");
    return { thresholds: { ...DEFAULT_THRESHOLDS }, roles: cloneRoles(DEFAULT_ROLES), effort: cloneRoles(DEFAULT_EFFORT), delegate: DEFAULT_DELEGATE, pace: DEFAULT_PACE, transcripts: DEFAULT_TRANSCRIPTS, problems };
  }

  const thresholds = { ...DEFAULT_THRESHOLDS };
  if (src.thresholds !== undefined) {
    if (!isObj(src.thresholds)) problems.push("thresholds is not an object");
    else {
      for (const [k, v] of Object.entries(src.thresholds)) {
        if (!Object.hasOwn(DEFAULT_THRESHOLDS, k)) problems.push(`thresholds.${k} is not a threshold (use steady, tight, out)`);
        else if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 99) problems.push(`thresholds.${k} must be a whole number from 1 to 99`);
        else thresholds[k] = v;
      }
      if (!(thresholds.steady < thresholds.tight && thresholds.tight < thresholds.out)) {
        problems.push("thresholds must rise: steady < tight < out (defaults used)");
        Object.assign(thresholds, DEFAULT_THRESHOLDS);
      }
    }
  }

  const roles = cloneRoles(DEFAULT_ROLES);
  if (src.roles !== undefined) {
    if (!isObj(src.roles)) problems.push("roles is not an object");
    else {
      for (const [mode, row] of Object.entries(src.roles)) {
        if (!MODES.includes(mode)) { problems.push(`roles.${mode} is not a mode (use ${MODES.join(", ")})`); continue; }
        if (!isObj(row)) { problems.push(`roles.${mode} is not an object`); continue; }
        for (const [role, model] of Object.entries(row)) {
          if (!ROLES.includes(role)) problems.push(`roles.${mode}.${role} is not a role (use ${ROLES.join(", ")})`);
          else if (!validModel(role, model)) problems.push(`roles.${mode}.${role} must be ${allowedModels(role).join(", ")}`);
          else roles[mode][role] = model;
        }
      }
    }
  }
  const effort = cloneRoles(DEFAULT_EFFORT);
  if (src.effort !== undefined) {
    if (!isObj(src.effort)) problems.push("effort is not an object");
    else {
      for (const [mode, row] of Object.entries(src.effort)) {
        if (!MODES.includes(mode)) { problems.push(`effort.${mode} is not a mode (use ${MODES.join(", ")})`); continue; }
        if (!isObj(row)) { problems.push(`effort.${mode} is not an object`); continue; }
        for (const [role, level] of Object.entries(row)) {
          if (!ROLES.includes(role)) problems.push(`effort.${mode}.${role} is not a role (use ${ROLES.join(", ")})`);
          else if (!EFFORTS.includes(level)) problems.push(`effort.${mode}.${role} must be ${EFFORTS.join(", ")}`);
          else effort[mode][role] = level;
        }
      }
    }
  }
  let delegate = DEFAULT_DELEGATE;
  if (src.delegate !== undefined) {
    if (DELEGATE.includes(src.delegate)) delegate = src.delegate;
    else problems.push(`delegate must be ${DELEGATE.join(", ")}`);
  }
  let pace = DEFAULT_PACE;
  if (src.pace !== undefined) {
    if (PACE.includes(src.pace)) pace = src.pace;
    else problems.push(`pace must be ${PACE.join(" or ")}`);
  }
  let transcripts = DEFAULT_TRANSCRIPTS;
  if (src.transcripts !== undefined) {
    if (TRANSCRIPTS.includes(src.transcripts)) transcripts = src.transcripts;
    else problems.push(`transcripts must be ${TRANSCRIPTS.join(" or ")}`);
  }
  // Keys starting with "_" are notes (like "_help") and are ignored.
  for (const k of Object.keys(src)) if (!k.startsWith("_") && !SETTINGS.includes(k)) problems.push(`${k} is not a setting (use ${SETTINGS.join(", ")})`);
  return { thresholds, roles, effort, delegate, pace, transcripts, problems };
}

const SETTINGS = ["thresholds", "roles", "effort", "delegate", "pace", "transcripts"];

export const CONFIG_HELP = [
  "Your own model-budget settings. Edit this file by hand, run /model-budget:budget-setup, or ask Claude to change them.",
  "thresholds: percent used where each mode starts. Whole numbers from 1 to 99, steady < tight < out. Exhausted is always 100.",
  "roles: the model for each role in each mode. The Fable limit's mode picks plan, build, review and final_check, unless the weekly limit is tight or worse and further along: then the weekly mode picks them. The weekly mode always picks mechanical.",
  "Models: fable, opus, sonnet, haiku. final_check can also be none.",
  "effort: the effort for each role's subagents in each mode, picked by the same mode as the model. Levels: low, medium, high, xhigh, max.",
  "delegate: when plan and review go to subagents. bigger (review for medium tasks, plan and review for large ones), always (plan and review for every task that changes code), or spawn_only.",
  "pace: on or off. On: a window used fast for the time gone moves one mode tighter (at most to tight), and one used slowly near its reset moves one mode looser. Never looser at the out threshold or over.",
  "transcripts: off or on. On: once a day, learn your usual weekly rhythm from the times and token counts in Claude Code's local transcripts, so pace follows it from day one. Only times and counts are kept and used, never text. Off: the rhythm is learnt from the readings over 2 to 3 weeks.",
  "A bad value falls back to its default and the Budget line says so. Delete this file to go back to all the defaults.",
];

/** The whole effective config, every value written out, for config.json. */
export function fullConfig(cfg) {
  const table = (src) => {
    const out = {};
    for (const m of MODES) {
      out[m] = {};
      for (const r of ROLES) out[m][r] = src[m][r];
    }
    return out;
  };
  return { _help: CONFIG_HELP, thresholds: { ...cfg.thresholds }, delegate: cfg.delegate, pace: cfg.pace, transcripts: cfg.transcripts ?? DEFAULT_TRANSCRIPTS, roles: table(cfg.roles), effort: table(cfg.effort) };
}

export const allowedModels = (role) => (role === "final_check" ? [...MODELS, "none"] : MODELS);
export const validModel = (role, v) => typeof v === "string" && allowedModels(role).includes(v);

function cloneRoles(r) {
  const out = {};
  for (const m of MODES) out[m] = { ...r[m] };
  return out;
}

// ---------- limits.json ----------

function windowOf(used, resetsAt, severity) {
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 1000 || !isIso(resetsAt)) return null;
  const w = { used, resets_at: resetsAt };
  if (typeof severity === "string" && SEVERITIES.includes(severity)) w.severity = severity;
  return w;
}

const validWindow = (v) => (isObj(v) ? windowOf(v.used, v.resets_at, v.severity) : null);

/** Shape check for limits.json read from disk. null when it is not one. */
export function parseLimits(raw) {
  if (!isObj(raw) || raw.version !== 1) return null;
  if (raw.fetched_at !== null && !isIso(raw.fetched_at)) return null;
  let last_error = null;
  if (isObj(raw.last_error) && isIso(raw.last_error.at) && typeof raw.last_error.message === "string") {
    last_error = { at: raw.last_error.at, message: raw.last_error.message.slice(0, 300) };
  }
  const fable_fetched_at = isIso(raw.fable_fetched_at) ? raw.fable_fetched_at : raw.fetched_at;
  return { version: 1, fetched_at: raw.fetched_at, fable_fetched_at, five_hour: validWindow(raw.five_hour), seven_day: validWindow(raw.seven_day), fable: validWindow(raw.fable), last_error };
}

/**
 * The three windows from Claude Code's answer to a `get_usage` control request (`response.rate_limits`).
 * `prev` supplies the Fable window when the answer lists none: Claude Code leaves `model_scoped` out
 * of cached answers. null when the answer carries no plan limits at all (API key login, no plan).
 */
export function windowsFromUsage(rateLimits, prev) {
  if (!isObj(rateLimits)) return null;
  const limits = Array.isArray(rateLimits.limits) ? rateLimits.limits.filter(isObj) : [];
  const severityOf = (pred) => limits.find(pred)?.severity;
  const plain = (key, kind) => {
    const w = rateLimits[key];
    return isObj(w) ? windowOf(w.utilization, w.resets_at, severityOf((l) => l.kind === kind)) : null;
  };
  const isFable = (l) => l.kind === "weekly_scoped" && isObj(l.scope) && isObj(l.scope.model) && l.scope.model.display_name === "Fable";

  let fable = null;
  const scoped = Array.isArray(rateLimits.model_scoped) ? rateLimits.model_scoped.filter(isObj) : null;
  const fromScoped = scoped?.find((m) => m.display_name === "Fable");
  if (fromScoped) fable = windowOf(fromScoped.utilization, fromScoped.resets_at, severityOf(isFable));
  if (!fable) {
    const l = limits.find(isFable);
    if (l) fable = windowOf(l.percent, l.resets_at, l.severity);
  }
  // No model_scoped at all means "not known this time", not "no Fable window": keep the last one.
  if (!fable && scoped === null) fable = prev?.fable ?? null;

  const out = { five_hour: plain("five_hour", "session"), seven_day: plain("seven_day", "weekly_all"), fable };
  return out.five_hour || out.seven_day || out.fable ? out : null;
}

const ageMs = (iso, nowMs) => (iso ? nowMs - Date.parse(iso) : Infinity);

/** "fresh" (under 45 min), "stale" (older), or "none" (never read). */
export function readingStatus(limits, nowMs) {
  if (!limits || limits.fetched_at === null) return "none";
  return ageMs(limits.fetched_at, nowMs) > STALE_AFTER_MS ? "stale" : "fresh";
}

/** True when the reading is over 15 min old and no check was tried in the last 5 min. */
export function needsRefresh(limits, nowMs) {
  if (ageMs(limits?.fetched_at, nowMs) <= REFRESH_AFTER_MS) return false;
  return ageMs(limits?.last_error?.at, nowMs) > RETRY_AFTER_MS;
}

// ---------- modes and roles ----------

/** `used` is the rounded percent shown in the line, so the line never says "90% tight". */
export function modeFor(used, severity, thresholds = DEFAULT_THRESHOLDS) {
  if (used >= 100) return "exhausted";
  if (used >= thresholds.out || severity === "critical") return "out";
  if (used >= thresholds.tight) return "tight";
  if (used >= thresholds.steady) return "steady";
  return "open";
}

/**
 * The % a window would reach at its reset at the rate used so far, or null when too little of the
 * window has gone to tell (or the reset time does not fit the window's length).
 */
export function paceFor(used, resetsInMin, windowMin) {
  if (!windowMin || resetsInMin <= 0 || resetsInMin > windowMin) return null;
  const gone = windowMin - resetsInMin; // minutes, so 10 % of 300 is exactly 30
  if (gone < PACE_MIN_ELAPSED * windowMin) return null;
  return Math.round((used * windowMin) / gone);
}

/**
 * The mode after pace, at most one step from the mode the % used gives:
 * - on pace for PACE_TIGHTER % or more: one step tighter, but never past tight;
 * - on pace for under PACE_LOOSER % with half the window gone: one step looser, but never from out or
 *   exhausted (at the out threshold, or Claude's own warning, the mode stays).
 */
export function pacedMode(mode, pace, resetsInMin, windowMin, tighterAt = PACE_TIGHTER.five_hour) {
  if (pace === null || pace === undefined) return mode;
  const i = MODES.indexOf(mode);
  // Pace never makes a window out: out comes from % used or Claude's own warning only.
  if (pace >= tighterAt && i < MODES.indexOf("tight")) return MODES[i + 1];
  // Pace is never below % used, so with the default thresholds only steady can become open.
  const gone = windowMin - resetsInMin;
  if (pace < PACE_LOOSER && gone >= PACE_LOOSER_ELAPSED * windowMin && i > 0 && i < MODES.indexOf("out")) return MODES[i - 1];
  return mode;
}

/**
 * A window whose reset time has passed counts as 0 % until the next reading.
 * `windowMin` (the window's length) turns on pace; without it the mode comes from the % used alone.
 * Pace is worked out at `readMs`, the time of the reading, so an ageing reading keeps its pace.
 */
export function budgetWindow(w, nowMs, thresholds = DEFAULT_THRESHOLDS, windowMin = null, readMs = nowMs, tighterAt = undefined, paceOf = null) {
  if (!w) return null;
  if (Date.parse(w.resets_at) <= nowMs) return { used: 0, mode: "open", used_mode: "open", pace: null, resets_at: w.resets_at, resets_in_min: 0 };
  const used = Math.round(w.used);
  const mins = Math.max(0, Math.round((Date.parse(w.resets_at) - nowMs) / 60_000));
  const usedMode = modeFor(used, w.severity, thresholds);
  const readMins = Math.round((Date.parse(w.resets_at) - readMs) / 60_000);
  // paceOf (the user's own pattern) replaces the straight line when it has an answer. The bar to
  // tighten follows whichever one answered.
  const fromPattern = windowMin && paceOf ? paceOf(used) : null;
  const pace = !windowMin ? null : fromPattern ?? paceFor(used, readMins, windowMin);
  const bar = fromPattern !== null && fromPattern !== undefined ? PACE_TIGHTER_PATTERN : tighterAt;
  const mode = pacedMode(usedMode, pace, readMins, windowMin, bar);
  const pace_from = pace === null ? null : fromPattern !== null && fromPattern !== undefined ? "pattern" : "line";
  return { used, mode, used_mode: usedMode, pace, pace_from, resets_at: w.resets_at, resets_in_min: mins };
}

/**
 * The mode that picks plan/build/review/final check: the Fable mode, or the weekly mode when that is
 * tight or worse and further along. Fable use counts against the weekly limit too, so a tight week
 * should move planning and review off Fable even when the Fable limit itself is fine.
 */
export function fableRoleMode(fableMode, weeklyMode) {
  const f = fableMode ?? "steady";
  const w = weeklyMode ?? "open";
  if (MODES.indexOf(w) < MODES.indexOf("tight")) return f;
  return MODES.indexOf(w) > MODES.indexOf(f) ? w : f;
}

/** fableRoleMode picks plan/build/review/final check; weekly mode picks mechanical.
 * No reading means Fable `steady` and weekly `open`: that is also the fallback. */
export function rolesFor(fableMode, weeklyMode, roles = DEFAULT_ROLES) {
  const f = roles[fableRoleMode(fableMode, weeklyMode)];
  const w = roles[weeklyMode ?? "open"];
  const out = {};
  for (const r of FABLE_ROLES) out[r] = f[r];
  for (const r of WEEKLY_ROLES) out[r] = w[r];
  return out;
}

/** The effort per role, picked by the same modes as the models. */
export const effortFor = (fableMode, weeklyMode, effort = DEFAULT_EFFORT) => rolesFor(fableMode, weeklyMode, effort);

// ---------- the line ----------

/** "16m", "2h05m", "3d4h". */
export function shortUntil(mins) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return mins % 60 ? `${h}h${String(mins % 60).padStart(2, "0")}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d${h % 24}h` : `${d}d`;
}

/** "3 h 12 min", "45 min", "2 d 4 h". */
export function longUntil(mins) {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return mins % 60 ? `${h} h ${mins % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

function windowText(label, w, withReset) {
  if (!w) return `${label} n/a`;
  const notes = [];
  // Say "on pace for" only when pace moved the mode, so the line stays short.
  if (w.pace !== null && w.pace !== undefined && w.mode !== w.used_mode) notes.push(`on pace for ${w.pace}%`);
  if (withReset && w.resets_in_min > 0) notes.push(`resets in ${shortUntil(w.resets_in_min)}`);
  return `${label} ${w.used}% ${w.mode}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

/**
 * "Plan fable high, build opus medium, review fable high, mechanical sonnet low." with final check
 * only when set. Without `effort` it names the models only.
 */
export function rolesText(roles, effort = null) {
  const parts = ROLES.filter((r) => roles[r] !== "none").map((r) => `${ROLE_LABEL[r]} ${roles[r]}${effort?.[r] ? ` ${effort[r]}` : ""}`);
  const s = parts.join(", ");
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

function adviceText(fiveHourMode) {
  let s = "";
  if (fiveHourMode === "tight") s += " No new parallel fan-outs.";
  else if (fiveHourMode === "out") s += " 5h nearly out: no new fan-outs, finish what is running.";
  else if (fiveHourMode === "exhausted") s += " 5h limit reached: start no new subagents.";
  return s;
}

function delegateText(delegate) {
  if (delegate === "always") return " Every task: plan and review in subagents on these models.";
  if (delegate === "spawn_only") return "";
  return " Medium and large tasks: review in a subagent, and plan in one too when large, on these models.";
}

const problemText = (problems) => (problems.length ? ` Settings have ${problems.length} problem${problems.length === 1 ? "" : "s"}, defaults used for them (ask Claude to show the model budget).` : "");

/** Strip control characters and cap the length: the line goes straight into the prompt. */
export function clean(s) {
  const t = String(s).replace(/[\u0000-\u001f\u007f]/g, " ");
  return t.length > MAX_LINE ? `${t.slice(0, MAX_LINE - 1)}…` : t;
}

export const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The whole budget: what budget.json holds and what the hook prints. */
export function buildBudget(limits, config, nowMs, history = null) {
  const cfg = config ?? resolveConfig(null);
  const status = readingStatus(limits, nowMs);
  const base = { schema_version: 1, at: isoSeconds(nowMs), limits_fetched_at: limits?.fetched_at ?? null, status };

  if (status !== "fresh") {
    const roles = rolesFor(null, null, cfg.roles);
    const effort = effortFor(null, null, cfg.effort);
    const failed = limits?.last_error ? `; last check failed: ${limits.last_error.message.slice(0, 120)}` : "";
    const what =
      status === "stale"
        ? `reading is stale (last good reading ${longUntil(Math.max(0, Math.round(ageMs(limits.fetched_at, nowMs) / 60_000)))} ago${failed})`
        : `no usage reading yet${failed}`;
    const line = clean(`Budget: ${what}. Fallback: ${rolesText(roles, effort)}${delegateText(cfg.delegate)}${problemText(cfg.problems)}`);
    return { ...base, five_hour: null, seven_day: null, fable: null, pace_source: paceSource(cfg, history), day: null, roles, effort, line };
  }

  const paceOn = cfg.pace !== "off";
  const len = (key) => (paceOn ? WINDOW_MIN[key] : null);
  const readAt = Date.parse(limits.fetched_at);
  const fableReadAt = Date.parse(limits.fable_fetched_at ?? limits.fetched_at);
  // The user's own weekly rhythm, when there is enough history. The 5h window keeps the straight line:
  // the history is in weekly %, which says nothing about a 5-hour window.
  const pattern = paceOn && history ? patternShares(history, { transcripts: cfg.transcripts === "on" }) : null;
  const day = pattern?.source === "readings" ? dayCheck(history, readAt) : null;
  const weekly = (w, at) => {
    if (!pattern || !w) return [PACE_TIGHTER.seven_day, null];
    const resetMs = Date.parse(w.resets_at);
    return [PACE_TIGHTER.seven_day, (used) => patternPace(used, resetMs, at, WINDOW_MIN.seven_day, pattern.shares, day)];
  };
  const five_hour = budgetWindow(limits.five_hour, nowMs, cfg.thresholds, len("five_hour"), readAt, PACE_TIGHTER.five_hour);
  const seven_day = budgetWindow(limits.seven_day, nowMs, cfg.thresholds, len("seven_day"), readAt, ...weekly(limits.seven_day, readAt));
  // A Fable window carried over from an older answer is dropped once it is stale itself.
  const fableFresh = ageMs(limits.fable_fetched_at ?? limits.fetched_at, nowMs) <= STALE_AFTER_MS;
  const fable = fableFresh ? budgetWindow(limits.fable, nowMs, cfg.thresholds, len("fable"), fableReadAt, ...weekly(limits.fable, fableReadAt)) : null;
  // A pace step between open and steady (either way) that changes nothing only adds noise: undo it.
  // 5h steady has no advice, and weekly steady only matters when its mechanical row differs from open.
  const openSteady = (w) => w && w.mode !== w.used_mode && ["open", "steady"].includes(w.mode) && ["open", "steady"].includes(w.used_mode);
  const undo = (w) => Object.assign(w, { mode: w.used_mode });
  if (openSteady(five_hour)) undo(five_hour);
  const sameRow = (t) => WEEKLY_ROLES.every((r) => t.open[r] === t.steady[r]);
  if (openSteady(seven_day) && sameRow(cfg.roles) && sameRow(cfg.effort ?? DEFAULT_EFFORT)) undo(seven_day);
  // Fable open and steady only differ when their plan, build, review or final check rows differ
  // (they are the same with "all Opus", for example).
  const sameFableRow = (t) => FABLE_ROLES.every((r) => t.open[r] === t.steady[r]);
  if (openSteady(fable) && sameFableRow(cfg.roles) && sameFableRow(cfg.effort ?? DEFAULT_EFFORT)) undo(fable);
  const roles = rolesFor(fable?.mode ?? null, seven_day?.mode ?? null, cfg.roles);
  const effort = effortFor(fable?.mode ?? null, seven_day?.mode ?? null, cfg.effort);
  const ageMin = Math.round(ageMs(limits.fetched_at, nowMs) / 60_000);
  const age = ageMs(limits.fetched_at, nowMs) > REFRESH_AFTER_MS ? ` Reading ${ageMin} min old.` : "";
  const head = `Budget: ${windowText("5h", five_hour, true)} · ${windowText("week", seven_day, true)} · ${windowText("Fable", fable, false)}.${dayText(day)}${age}`;
  // With the 5-hour limit reached, no subagents at all: drop the delegate sentence.
  const delegate = five_hour?.mode === "exhausted" ? "" : delegateText(cfg.delegate);
  const line = clean(`${head} ${rolesText(roles, effort)}${delegate}${adviceText(five_hour?.mode)}${problemText(cfg.problems)}`);
  return { ...base, five_hour, seven_day, fable, pace_source: pattern ? pattern.source : paceOn ? "straight line" : "off", day, roles, effort, line };
}

/** Where weekly pace comes from: "readings", "transcripts", "straight line" or "off". */
export function paceSource(cfg, history) {
  if (cfg.pace === "off") return "off";
  const p = history ? patternShares(history, { transcripts: cfg.transcripts === "on" }) : null;
  return p ? p.source : "straight line";
}

/** " Heavy day: 12 points of the week used today, usually 4 by now." */
function dayText(day) {
  if (!day || day.kind === "usual") return "";
  const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  return ` ${day.kind === "heavy" ? "Heavy" : "Quiet"} day: ${fmt(day.actual)} points of the week used today, usually ${fmt(day.typical)} by now.`;
}
