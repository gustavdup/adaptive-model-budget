// model-budget: pure rules. No I/O, no network.
// Turns a limits reading (limits.json) and the user's config (config.json) into a mode per window,
// a model per role and the one-line Budget summary. Everything here is a plain function so it can be
// tested without touching the disk.

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
    return { thresholds: { ...DEFAULT_THRESHOLDS }, roles: cloneRoles(DEFAULT_ROLES), delegate: DEFAULT_DELEGATE, problems };
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
  let delegate = DEFAULT_DELEGATE;
  if (src.delegate !== undefined) {
    if (DELEGATE.includes(src.delegate)) delegate = src.delegate;
    else problems.push(`delegate must be ${DELEGATE.join(", ")}`);
  }
  // Keys starting with "_" are notes (like "_help") and are ignored.
  for (const k of Object.keys(src)) if (!k.startsWith("_") && !["thresholds", "roles", "delegate"].includes(k)) problems.push(`${k} is not a setting (use thresholds, roles, delegate)`);
  return { thresholds, roles, delegate, problems };
}

export const CONFIG_HELP = [
  "Your own model-budget settings. Edit this file by hand, run /model-budget:budget-setup, or ask Claude to change them.",
  "thresholds: percent used where each mode starts. Whole numbers from 1 to 99, steady < tight < out. Exhausted is always 100.",
  "roles: the model for each role in each mode. The Fable limit's mode picks plan, build, review and final_check, unless the weekly limit is tight or worse and further along: then the weekly mode picks them. The weekly mode always picks mechanical.",
  "Models: fable, opus, sonnet, haiku. final_check can also be none.",
  "delegate: when plan and review go to subagents. bigger (tasks bigger than a quick fix), always, or spawn_only.",
  "A bad value falls back to its default and the Budget line says so. Delete this file to go back to all the defaults.",
];

/** The whole effective config, every value written out, for config.json. */
export function fullConfig(cfg) {
  const roles = {};
  for (const m of MODES) {
    roles[m] = {};
    for (const r of ROLES) roles[m][r] = cfg.roles[m][r];
  }
  return { _help: CONFIG_HELP, thresholds: { ...cfg.thresholds }, delegate: cfg.delegate, roles };
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

/** A window whose reset time has passed counts as 0 % until the next reading. */
export function budgetWindow(w, nowMs, thresholds = DEFAULT_THRESHOLDS) {
  if (!w) return null;
  if (Date.parse(w.resets_at) <= nowMs) return { used: 0, mode: "open", resets_at: w.resets_at, resets_in_min: 0 };
  const used = Math.round(w.used);
  const mins = Math.max(0, Math.round((Date.parse(w.resets_at) - nowMs) / 60_000));
  return { used, mode: modeFor(used, w.severity, thresholds), resets_at: w.resets_at, resets_in_min: mins };
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
  const reset = withReset && w.resets_in_min > 0 ? ` (resets in ${shortUntil(w.resets_in_min)})` : "";
  return `${label} ${w.used}% ${w.mode}${reset}`;
}

/** "Plan fable, build opus, review fable, mechanical sonnet." with final check only when set. */
export function rolesText(roles) {
  const parts = ROLES.filter((r) => roles[r] !== "none").map((r) => `${ROLE_LABEL[r]} ${roles[r]}`);
  const s = parts.join(", ");
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

function adviceText(fiveHourMode, weeklyMode) {
  let s = "";
  if (weeklyMode === "tight") s += " Subagent effort one level lower.";
  else if (weeklyMode === "out" || weeklyMode === "exhausted") s += " Lowest subagent effort that holds quality.";
  if (fiveHourMode === "tight") s += " No new parallel fan-outs.";
  else if (fiveHourMode === "out") s += " 5h nearly out: no new fan-outs, finish what is running.";
  else if (fiveHourMode === "exhausted") s += " 5h limit reached: start no new subagents.";
  return s;
}

function delegateText(delegate) {
  if (delegate === "always") return " Every task: plan and review in subagents on these models.";
  if (delegate === "spawn_only") return "";
  return " Bigger tasks: plan and review in subagents on these models.";
}

const problemText = (problems) => (problems.length ? ` Settings have ${problems.length} problem${problems.length === 1 ? "" : "s"}, defaults used for them (ask Claude to show the model budget).` : "");

/** Strip control characters and cap the length: the line goes straight into the prompt. */
export function clean(s) {
  const t = String(s).replace(/[\u0000-\u001f\u007f]/g, " ");
  return t.length > MAX_LINE ? `${t.slice(0, MAX_LINE - 1)}…` : t;
}

export const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The whole budget: what budget.json holds and what the hook prints. */
export function buildBudget(limits, config, nowMs) {
  const cfg = config ?? resolveConfig(null);
  const status = readingStatus(limits, nowMs);
  const base = { schema_version: 1, at: isoSeconds(nowMs), limits_fetched_at: limits?.fetched_at ?? null, status };

  if (status !== "fresh") {
    const roles = rolesFor(null, null, cfg.roles);
    const failed = limits?.last_error ? `; last check failed: ${limits.last_error.message.slice(0, 120)}` : "";
    const what =
      status === "stale"
        ? `reading is stale (last good reading ${longUntil(Math.max(0, Math.round(ageMs(limits.fetched_at, nowMs) / 60_000)))} ago${failed})`
        : `no usage reading yet${failed}`;
    const line = clean(`Budget: ${what}. Fallback: ${rolesText(roles)}${delegateText(cfg.delegate)}${problemText(cfg.problems)}`);
    return { ...base, five_hour: null, seven_day: null, fable: null, roles, line };
  }

  const five_hour = budgetWindow(limits.five_hour, nowMs, cfg.thresholds);
  const seven_day = budgetWindow(limits.seven_day, nowMs, cfg.thresholds);
  // A Fable window carried over from an older answer is dropped once it is stale itself.
  const fableFresh = ageMs(limits.fable_fetched_at ?? limits.fetched_at, nowMs) <= STALE_AFTER_MS;
  const fable = fableFresh ? budgetWindow(limits.fable, nowMs, cfg.thresholds) : null;
  const roles = rolesFor(fable?.mode ?? null, seven_day?.mode ?? null, cfg.roles);
  const ageMin = Math.round(ageMs(limits.fetched_at, nowMs) / 60_000);
  const age = ageMs(limits.fetched_at, nowMs) > REFRESH_AFTER_MS ? ` Reading ${ageMin} min old.` : "";
  const head = `Budget: ${windowText("5h", five_hour, true)} · ${windowText("week", seven_day, true)} · ${windowText("Fable", fable, false)}.${age}`;
  // With the 5-hour limit reached, no subagents at all: drop the delegate sentence.
  const delegate = five_hour?.mode === "exhausted" ? "" : delegateText(cfg.delegate);
  const line = clean(`${head} ${rolesText(roles)}${delegate}${adviceText(five_hour?.mode, seven_day?.mode)}${problemText(cfg.problems)}`);
  return { ...base, five_hour, seven_day, fable, roles, line };
}
