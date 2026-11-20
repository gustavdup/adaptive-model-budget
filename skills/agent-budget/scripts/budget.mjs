#!/usr/bin/env node
// model-budget: the one command. Plain Node 18+, no dependencies.
//
//   node budget.mjs                  check: refresh if over 15 min old, then print the Budget line
//   node budget.mjs hook             for the UserPromptSubmit hook: print the line now, refresh in the background
//   node budget.mjs refresh [--force] [--quiet]
//   node budget.mjs show             reading, pace, thresholds, model and effort tables, background job, config problems
//   node budget.mjs config           print the effective config as JSON
//   node budget.mjs config set KEY=VALUE ...   e.g. thresholds.tight=80 open.plan=opus all.mechanical=haiku effort.all.build=high delegate=always pace=off
//   node budget.mjs config init      write every setting out to config.json, ready to edit by hand
//   node budget.mjs config reset     back to the defaults (written out in full)
//   node budget.mjs job on|off|status
//   node budget.mjs uninstall --yes  remove the job and the whole config folder
//
// Files live in ~/.config/model-budget (MODEL_BUDGET_DIR overrides it): config.json, limits.json,
// budget.json, history.json. Folder 0700, files 0600, written with a temp file and rename.

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_EFFORT, DEFAULT_ROLES, DELEGATE, EFFORTS, MAX_FILE_BYTES, MODES, PACE, PACE_LOOSER, PACE_TIGHTER, PACE_TIGHTER_PATTERN, ROLES, TRANSCRIPTS, buildBudget, clean, effortFor, fullConfig, longUntil, needsRefresh, parseLimits, resolveConfig, rolesFor, rolesText, validModel } from "./core.mjs";
import { fetchLimits, findClaude } from "./fetch.mjs";
import { MIN_WEEKS, goodWeeks, parseHistory, recordReading } from "./history.mjs";
import { scanTranscripts } from "./transcripts.mjs";
import { installJob, jobStatus, syncJobScripts, uninstallJob } from "./job.mjs";

const SELF = fileURLToPath(import.meta.url);
const LOCK_STALE_MS = 60_000;
export const OWN_FILES = ["config.json", "limits.json", "budget.json", "history.json", "refresh.lock", "run.log", "bin"];
/** The transcript scan runs at most this often, and only in a background refresh. */
const SCAN_EVERY_MS = 24 * 3_600_000;

export const configDir = (env = process.env) => env.MODEL_BUDGET_DIR || join(homedir(), ".config", "model-budget");
const paths = (dir) => ({
  config: join(dir, "config.json"),
  limits: join(dir, "limits.json"),
  budget: join(dir, "budget.json"),
  history: join(dir, "history.json"),
  lock: join(dir, "refresh.lock"),
});

// ---------- files ----------

function readJson(path) {
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return { error: "file too big" };
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (e) {
    return e.code === "ENOENT" || e.code === "ENOTDIR" ? { missing: true } : { error: e instanceof SyntaxError ? "not valid JSON" : e.code ?? "unreadable" };
  }
}

export function writeAtomic(path, value, { compact = false } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function loadConfig(dir) {
  const r = readJson(paths(dir).config);
  if (r.missing) return { raw: null, ...resolveConfig(null) };
  if (r.error) return { raw: null, ...resolveConfig(null), problems: [`config.json: ${r.error}`] };
  return { raw: r.value, ...resolveConfig(r.value) };
}

export const loadLimits = (dir) => parseLimits(readJson(paths(dir).limits).value);
/** history.json, or an empty history when it is missing or bad. Written compact, so it stays under 16 KB. */
export const loadHistory = (dir) => parseHistory(readJson(paths(dir).history).value);

/** The budget for now, from the files on disk. */
export const currentBudget = (dir, nowMs = Date.now()) => buildBudget(loadLimits(dir), loadConfig(dir), nowMs, loadHistory(dir));

/**
 * Add a good reading to history.json. Returns true when a transcript scan is due (transcripts=on and
 * none in the last day). Never fails the refresh: the history is a nice-to-have.
 */
function recordHistory(dir, file, nowMs) {
  try {
    let h = loadHistory(dir);
    if (file.seven_day && file.fetched_at) h = recordReading(h, { at: file.fetched_at, used: file.seven_day.used, resets_at: file.seven_day.resets_at });
    const on = loadConfig(dir).transcripts === "on";
    if (!on) h.transcripts = null;
    writeAtomic(paths(dir).history, h, { compact: true });
    return on && !(nowMs - Date.parse(h.transcripts?.scanned_at ?? 0) < SCAN_EVERY_MS);
  } catch {
    return false;
  }
}

/**
 * The transcript scan, after the lock is released: it can take a while. The result is merged into a
 * fresh read. The scan time is kept even when it found nothing or failed, so it waits a day either way.
 */
async function scanIntoHistory(dir, scanner, nowMs) {
  let shares = null;
  try {
    shares = (await scanner({ nowMs }))?.shares ?? null;
  } catch {}
  try {
    const h = loadHistory(dir);
    if (loadConfig(dir).transcripts !== "on") return;
    h.transcripts = { scanned_at: new Date(nowMs).toISOString(), shares };
    writeAtomic(paths(dir).history, h, { compact: true });
  } catch {}
}

// ---------- refresh (with a lock, so open sessions never fetch twice at once) ----------

/** Returns a token when the lock was taken, else null. */
function takeLock(path) {
  const token = `${process.pid} ${Date.now()} ${Math.random().toString(36).slice(2)}\n`;
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, token);
      closeSync(fd);
      return token;
    } catch (e) {
      if (e.code === "ENOENT") {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        continue;
      }
      if (e.code !== "EEXIST") throw e; // cannot write the folder: let the caller say so
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
          rmSync(path, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      return null;
    }
  }
  return null;
}

/** Remove the lock only if it is still ours (it may have gone stale and been taken by another run). */
function releaseLock(path, token) {
  try {
    if (statSync(path).size <= 256 && readFileSync(path, "utf8") === token) rmSync(path, { force: true });
  } catch {}
}

const lockHeld = (path) => {
  try {
    return Date.now() - statSync(path).mtimeMs <= LOCK_STALE_MS;
  } catch {
    return false;
  }
};

/** Fetch when needed (or forced). Returns { ran, ok, budget }. */
export async function refresh(dir, { force = false, now = () => Date.now(), fetch = fetchLimits, env = process.env, scan = false, scanner = scanTranscripts } = {}) {
  const p = paths(dir);
  if (!force && !needsRefresh(loadLimits(dir), now())) return { ran: false, ok: true, budget: currentBudget(dir, now()) };
  const token = takeLock(p.lock);
  if (!token) return { ran: false, ok: true, busy: true, budget: currentBudget(dir, now()) };
  let scanDue = false;
  let result;
  try {
    const prev = loadLimits(dir);
    if (!force && !needsRefresh(prev, now())) return { ran: false, ok: true, budget: currentBudget(dir, now()) };
    const { ok, file } = await fetch(prev, { claude: findClaude(env), now });
    writeAtomic(p.limits, file);
    if (ok) scanDue = recordHistory(dir, file, now()) && scan;
    const budget = currentBudget(dir, now());
    writeAtomic(p.budget, budget);
    result = { ran: true, ok, budget, error: ok ? null : file.last_error?.message };
  } finally {
    releaseLock(p.lock, token);
  }
  if (scanDue) await scanIntoHistory(dir, scanner, now());
  return result;
}

async function waitForLock(path, maxMs) {
  const end = Date.now() + maxMs;
  while (lockHeld(path) && Date.now() < end) await new Promise((r) => setTimeout(r, 500));
}

// ---------- hook ----------

const SAFE_FALLBACK = `Budget: unknown. Fallback: ${rolesText(rolesFor(null, null, DEFAULT_ROLES), effortFor(null, null, DEFAULT_EFFORT))}`;

/** Print the line straight away; start a background refresh when the reading is over 15 min old. */
export function hook(dir, { nowMs = Date.now(), spawnRefresh = defaultSpawn, sourceDir = dirname(SELF) } = {}) {
  let line = SAFE_FALLBACK;
  try {
    // After a plugin update, the job would keep running its old copy: refresh it.
    if (dirname(SELF) !== join(dir, "bin")) syncJobScripts(dir, sourceDir);
  } catch {}
  try {
    const limits = loadLimits(dir);
    line = buildBudget(limits, loadConfig(dir), nowMs, loadHistory(dir)).line;
    if (needsRefresh(limits, nowMs) && !lockHeld(paths(dir).lock)) spawnRefresh();
  } catch {
    // never block a prompt
  }
  return clean(line);
}

function defaultSpawn() {
  const child = spawn(process.execPath, [SELF, "refresh", "--quiet"], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
}

// ---------- show ----------

const pad = (s, n) => String(s).padEnd(n);

export function showText(dir, nowMs = Date.now()) {
  const cfg = loadConfig(dir);
  const limits = loadLimits(dir);
  const history = loadHistory(dir);
  const b = buildBudget(limits, cfg, nowMs, history);
  const out = [b.line, ""];
  if (limits?.fetched_at) out.push(`Reading: ${longUntil(Math.max(0, Math.round((nowMs - Date.parse(limits.fetched_at)) / 60_000)))} old (${limits.fetched_at}).`);
  else out.push("Reading: none yet.");
  if (limits?.last_error) out.push(`Last check failed at ${limits.last_error.at}: ${limits.last_error.message}`);
  const t = cfg.thresholds;
  out.push(`Thresholds: open under ${t.steady} %, steady ${t.steady} to ${t.tight} %, tight ${t.tight} to ${t.out} %, out ${t.out} % or more, exhausted 100 %.`);
  out.push(`Delegate: ${cfg.delegate} (bigger: a review subagent for medium tasks, plan and review subagents for large ones; always: plan and review for every task that changes code; spawn_only: only when spawning anyway).`);
  out.push(`Pace: ${cfg.pace} (on: on pace for ${PACE_TIGHTER.five_hour} % or more at the reset moves a window one mode tighter, at most to tight; on pace for under ${PACE_LOOSER} % with half the window gone moves it one mode looser, never from out).`);
  const weeks = goodWeeks(history).length;
  const wk = `${weeks} full week${weeks === 1 ? "" : "s"} of readings`;
  const source =
    b.pace_source === "readings" ? `your own rhythm (${wk}, tighter at ${PACE_TIGHTER_PATTERN} %)`
    : b.pace_source === "transcripts" ? `your transcript rhythm (scanned ${history.transcripts.scanned_at.slice(0, 10)}, tighter at ${PACE_TIGHTER_PATTERN} %) until there are ${MIN_WEEKS} weeks of readings (now ${weeks})`
    : b.pace_source === "off" ? "nothing (pace is off)"
    : `a straight line (tighter at ${PACE_TIGHTER.seven_day} %) until there are ${MIN_WEEKS} weeks of readings (now ${weeks})`;
  out.push(`  Weekly and Fable pace follow ${source}. The 5h window always uses a straight line.`);
  const scanned = history.transcripts ? ` (last scan ${history.transcripts.scanned_at.slice(0, 10)}${history.transcripts.shares ? "" : ", found nothing"})` : " (no scan yet: it runs in the next background check)";
  out.push(`  Transcript scan: ${cfg.transcripts}${cfg.transcripts === "on" ? scanned : " (turn on with config set transcripts=on)"}.`);
  if (b.day) out.push(`  Today: ${b.day.actual} points of the week used, usually ${b.day.typical} by now (${b.day.kind}).`);
  for (const [key, label] of [["five_hour", "5h"], ["seven_day", "week"], ["fable", "Fable"]]) {
    const w = b[key];
    if (w && w.pace !== null && w.pace !== undefined) out.push(`  ${label}: ${w.used} % used, on pace for ${w.pace} % at the reset${w.mode !== w.used_mode ? ` (${w.used_mode} by % used, ${w.mode} by pace)` : ""}.`);
  }
  out.push("", "Roles. Plan, build, review and final check follow the Fable mode, or the weekly mode once that is tight or worse and further along. Mechanical follows the weekly mode.");
  out.push(`  ${pad("mode", 10)}${ROLES.map((r) => pad(r, 12)).join("")}`);
  for (const m of MODES) out.push(`  ${pad(m, 10)}${ROLES.map((r) => pad(cfg.roles[m][r], 12)).join("")}`);
  out.push("", "Subagent effort, picked by the same modes as the models.");
  out.push(`  ${pad("mode", 10)}${ROLES.map((r) => pad(r, 12)).join("")}`);
  for (const m of MODES) out.push(`  ${pad(m, 10)}${ROLES.map((r) => pad(cfg.effort[m][r], 12)).join("")}`);
  const job = jobStatus();
  out.push("", `Background job: ${job}.`);
  if (job.startsWith("on") && b.status !== "fresh") out.push(`  Warning: the job is on but the reading is not fresh. Check ${join(dir, "run.log")}, then re-run setup.`);
  out.push(`Settings file: ${paths(dir).config}${cfg.raw ? "" : " (not written yet: all defaults; `config init` writes it out)"}.`);
  for (const p of cfg.problems) out.push(`  Problem: ${p}`);
  return out.join("\n");
}

// ---------- config set ----------

/** Apply KEY=VALUE pairs to a raw config. Throws with a clear message on a bad key or value. */
export function applySettings(raw, pairs) {
  const next = structuredClone(raw ?? {});
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw new Error(`"${pair}" is not KEY=VALUE`);
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const parts = key.split(".");
    if (parts[0] === "roles") parts.shift();
    const allModes = (mode) => (mode === "*" || mode === "all" ? MODES : [mode]);
    const isMode = (mode) => MODES.includes(mode) || mode === "*" || mode === "all";
    if (key === "delegate") {
      if (!DELEGATE.includes(value)) throw new Error(`delegate must be ${DELEGATE.join(", ")}`);
      next.delegate = value;
    } else if (key === "transcripts") {
      if (!TRANSCRIPTS.includes(value)) throw new Error(`transcripts must be ${TRANSCRIPTS.join(" or ")}`);
      next.transcripts = value;
    } else if (key === "pace") {
      if (!PACE.includes(value)) throw new Error(`pace must be ${PACE.join(" or ")}`);
      next.pace = value;
    } else if (parts[0] === "effort") {
      if (parts.length !== 3) throw new Error(`${key}: use effort.<mode>.<role>, for example effort.all.build=high`);
      const [, mode, role] = parts;
      if (!isMode(mode)) throw new Error(`${key}: mode must be ${MODES.join(", ")} or all`);
      if (!ROLES.includes(role)) throw new Error(`${key}: role must be ${ROLES.join(", ")}`);
      if (!EFFORTS.includes(value)) throw new Error(`${key}: effort must be ${EFFORTS.join(", ")}`);
      next.effort = next.effort ?? {};
      for (const m of allModes(mode)) next.effort[m] = { ...(next.effort[m] ?? {}), [role]: value };
    } else if (parts[0] === "thresholds" && parts.length === 2) {
      const n = Number(value);
      if (!["steady", "tight", "out"].includes(parts[1])) throw new Error(`${key}: use thresholds.steady, thresholds.tight or thresholds.out`);
      if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error(`${key} must be a whole number from 1 to 99`);
      next.thresholds = { ...(next.thresholds ?? {}), [parts[1]]: n };
    } else if (parts.length === 2 && isMode(parts[0])) {
      const [mode, role] = parts;
      if (!ROLES.includes(role)) throw new Error(`${key}: role must be ${ROLES.join(", ")}`);
      if (!validModel(role, value)) throw new Error(`${key}: model must be ${role === "final_check" ? "fable, opus, sonnet, haiku or none" : "fable, opus, sonnet or haiku"}`);
      next.roles = next.roles ?? {};
      for (const m of allModes(mode)) next.roles[m] = { ...(next.roles[m] ?? {}), [role]: value };
    } else {
      throw new Error(`unknown setting "${key}". Use thresholds.steady|tight|out, <mode>.<role> (mode ${MODES.join("/")} or all), effort.<mode>.<role>, delegate, pace or transcripts`);
    }
  }
  const { problems } = resolveConfig(next);
  if (problems.length) throw new Error(problems.join("; "));
  return next;
}

// ---------- CLI ----------

async function main(argv) {
  const dir = configDir();
  const [cmd = "check", ...rest] = argv;
  const flag = (f) => rest.includes(f);
  // Refuse anything extra, so a pre-approved command (like `show`) can never carry another one.
  const only = (...allowed) => {
    const extra = rest.find((a) => !allowed.includes(a));
    if (extra !== undefined) throw new Error(`unexpected argument "${extra}" for ${cmd}`);
  };

  switch (cmd) {
    case "hook":
      console.log(hook(dir));
      return 0;

    case "check": {
      only();
      // Always print a line, even when the folder cannot be written (read-only home, sandbox).
      try {
        // A skill-only install has no hook: keep the job's copy current here instead.
        if (dirname(SELF) !== join(dir, "bin")) syncJobScripts(dir, dirname(SELF));
      } catch {}
      try {
        const p = paths(dir);
        if (lockHeld(p.lock)) await waitForLock(p.lock, 35_000);
        const r = await refresh(dir);
        if (r.busy) await waitForLock(p.lock, 35_000);
        console.log(currentBudget(dir).line);
      } catch (e) {
        let line = SAFE_FALLBACK;
        try {
          line = currentBudget(dir).line;
        } catch {}
        console.log(clean(`${line} (Could not update the reading: ${e.code ?? e.message}.)`));
      }
      return 0;
    }

    case "refresh": {
      only("--force", "--quiet");
      // --quiet is the background run (the hook's spawn and the job): only it may scan transcripts.
      const r = await refresh(dir, { force: flag("--force"), scan: flag("--quiet") });
      const stamp = new Date().toISOString();
      if (flag("--quiet")) {
        if (r.ran) console.log(`${stamp} ${r.ok ? "ok" : `failed: ${r.error}`}`);
      } else {
        if (r.ran && !r.ok) console.error(`Check failed: ${r.error}`);
        else if (!r.ran) console.error(r.busy ? "Another check is running." : "Reading is under 15 minutes old (use --force to check anyway).");
        console.log(r.budget.line);
      }
      return r.ok ? 0 : 1;
    }

    case "show":
      only();
      console.log(showText(dir));
      return 0;

    case "config": {
      const sub = rest[0] ?? "show";
      if (sub !== "set" && rest.length > 1) throw new Error(`unexpected argument "${rest[1]}" for config ${sub}`);
      if (sub === "set" && rest.slice(1).some((a) => !a.includes("="))) throw new Error(`config set takes only KEY=VALUE pairs, not "${rest.slice(1).find((a) => !a.includes("="))}"`);
      if (sub === "show") {
        const { thresholds, roles, effort, delegate, pace, transcripts, problems } = loadConfig(dir);
        console.log(JSON.stringify({ thresholds, delegate, pace, transcripts, roles, effort, problems }, null, 2));
        return 0;
      }
      if (sub === "init") {
        // Write every value out so the file is easy to edit by hand. Keeps any existing settings.
        const cur = loadConfig(dir);
        if (cur.problems.length) throw new Error(`config.json has problems, fix them first: ${cur.problems.join("; ")}`);
        writeAtomic(paths(dir).config, fullConfig(cur));
        console.log(`Settings file: ${paths(dir).config}`);
        return 0;
      }
      if (sub === "reset") {
        writeAtomic(paths(dir).config, fullConfig(resolveConfig(null)));
        console.log(`Settings reset to the defaults: ${paths(dir).config}`);
        console.log(currentBudget(dir).line);
        return 0;
      }
      if (sub === "set") {
        if (rest.length < 2) throw new Error("config set needs at least one KEY=VALUE");
        const cur = loadConfig(dir);
        if (cur.raw === null && cur.problems.length) throw new Error(`config.json has problems, fix them first: ${cur.problems.join("; ")}`);
        const next = resolveConfig(applySettings(cur.raw, rest.slice(1)));
        writeAtomic(paths(dir).config, fullConfig(next));
        const b = currentBudget(dir);
        writeAtomic(paths(dir).budget, b);
        console.log(`Saved to ${paths(dir).config}`);
        console.log(b.line);
        return 0;
      }
      throw new Error(`unknown config command "${sub}" (use show, init, set, reset)`);
    }

    case "job": {
      const sub = rest[0] ?? "status";
      if (rest.length > 1) throw new Error(`unexpected argument "${rest[1]}" for job ${sub}`);
      if (sub === "on") console.log(installJob({ dir, claude: findClaude(), sourceDir: dirname(SELF) }));
      else if (sub === "off") console.log(uninstallJob({ dir }));
      else if (sub === "status") console.log(`Background job: ${jobStatus()}.`);
      else throw new Error(`unknown job command "${sub}" (use on, off, status)`);
      return 0;
    }

    case "uninstall": {
      only("--yes");
      if (!flag("--yes")) {
        console.log(`This removes the background job (if any) and deletes the model-budget files in ${dir}, including config.json. Run again with --yes to do it.`);
        return 1;
      }
      console.log(uninstallJob({ dir }));
      // Delete only our own files, never the whole folder: MODEL_BUDGET_DIR may point somewhere shared.
      for (const f of OWN_FILES) rmSync(join(dir, f), { recursive: true, force: true });
      try {
        rmdirSync(dir);
      } catch {}
      console.log(`Removed the model-budget files from ${dir}. To remove the plugin too: /plugin uninstall model-budget`);
      return 0;
    }

    default:
      throw new Error(`unknown command "${cmd}" (use check, hook, refresh, show, config, job, uninstall)`);
  }
}

const isMain = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SELF);
  } catch {
    return false;
  }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  main(argv).then(
    (code) => process.exit(code),
    (e) => {
      if (argv[0] === "hook") {
        console.log(SAFE_FALLBACK);
        process.exit(0);
      }
      console.error(`model-budget: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
