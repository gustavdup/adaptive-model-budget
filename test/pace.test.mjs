import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EFFORT, WINDOW_MIN, budgetWindow, buildBudget, effortFor, fullConfig, paceFor, pacedMode, resolveConfig,
} from "../skills/agent-budget/scripts/core.mjs";
import { applySettings, writeAtomic } from "../skills/agent-budget/scripts/budget.mjs";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const min = 60_000;
const day = 24 * 60;
const win = (used, inMin, severity) => ({ used, resets_at: iso(NOW + inMin * min), ...(severity ? { severity } : {}) });
const limits = (over = {}) => ({ version: 1, fetched_at: iso(NOW - 2 * min), five_hour: win(20, 120), seven_day: win(10, 6000), fable: win(10, 6000), last_error: null, ...over });
const WEEK = WINDOW_MIN.seven_day;

// ---------- pace ----------

test("pace is the % the window reaches at its reset at this rate", () => {
  assert.equal(paceFor(60, 4 * day, WEEK), 140); // 3 of 7 days gone
  assert.equal(paceFor(20, 120, 300), 33); // 3 of 5 hours gone
});

test("pace waits until 10 % of the window has gone", () => {
  assert.equal(paceFor(5, WEEK - 60, WEEK), null);
  assert.equal(paceFor(15, 270, 300), 150); // exactly 10 % gone
});

test("pace is null for a reset time that does not fit the window", () => {
  assert.equal(paceFor(10, 0, WEEK), null);
  assert.equal(paceFor(10, WEEK + 60, WEEK), null);
  assert.equal(paceFor(10, 100, null), null);
});

test("fast pace moves one mode tighter, never past tight", () => {
  assert.equal(pacedMode("open", 140, 4 * day, WEEK), "steady");
  assert.equal(pacedMode("steady", 140, 4 * day, WEEK), "tight");
  assert.equal(pacedMode("tight", 140, 4 * day, WEEK), "tight");
  assert.equal(pacedMode("out", 300, 4 * day, WEEK), "out");
  assert.equal(pacedMode("exhausted", 300, 4 * day, WEEK), "exhausted");
  assert.equal(pacedMode("open", 109, 4 * day, WEEK), "open");
  assert.equal(pacedMode("open", 110, 4 * day, WEEK), "steady");
  assert.equal(pacedMode("open", 120, 4 * day, WEEK, 130), "open"); // the weekly bar
});

test("5h at 75 % with 1h40 left stays tight, not out", () => {
  const b = buildBudget(limits({ five_hour: win(75, 100) }), resolveConfig(null), NOW);
  assert.equal(b.five_hour.pace, 114);
  assert.equal(b.five_hour.mode, "tight");
  assert.doesNotMatch(b.line, /nearly out/);
});

test("the weekly windows need 130 % to tighten", () => {
  // Week 60 % with 3.5 days left is on pace for 120 %: still steady.
  const b = buildBudget(limits({ seven_day: win(60, 5040), fable: win(10, 5040) }), resolveConfig(null), NOW);
  assert.equal(b.seven_day.pace, 120);
  assert.equal(b.seven_day.mode, "steady");
});

test("pace is worked out at the time of the reading, so an old reading keeps it", () => {
  // 55 % at 150 min into the 5h window: pace 110, tight. 40 min later with no new reading, still tight.
  const at = NOW - 40 * min;
  const l = limits({ fetched_at: iso(at), five_hour: win(55, 150 - 40) });
  const b = buildBudget(l, resolveConfig(null), NOW);
  assert.equal(b.five_hour.pace, 110);
  assert.equal(b.five_hour.mode, "tight");
  assert.equal(b.five_hour.resets_in_min, 110);
});

test("a carried Fable window gets its pace from its own reading time", () => {
  const l = limits({ fetched_at: iso(NOW - 2 * min), fable_fetched_at: iso(NOW - 30 * min), fable: win(55, day - 30) });
  const b = buildBudget(l, resolveConfig(null), NOW);
  assert.equal(b.fable.pace, 64); // 55 % with 1 day left at the reading
  assert.equal(b.fable.mode, "open");
});

test("slow pace moves one mode looser only with half the window gone, and never from out", () => {
  assert.equal(pacedMode("steady", 60, 2 * day, WEEK), "open"); // 5 of 7 days gone
  assert.equal(pacedMode("tight", 60, 2 * day, WEEK), "steady");
  assert.equal(pacedMode("steady", 60, 4 * day, WEEK), "steady"); // under half gone
  assert.equal(pacedMode("steady", 70, 2 * day, WEEK), "steady");
  assert.equal(pacedMode("out", 10, 60, WEEK), "out");
  assert.equal(pacedMode("open", 10, 60, WEEK), "open");
});

test("budgetWindow keeps the mode by % used and the mode after pace", () => {
  const w = budgetWindow(win(60, 4 * day), NOW, undefined, WEEK);
  assert.deepEqual([w.used, w.used_mode, w.pace, w.mode], [60, "steady", 140, "tight"]);
  const plain = budgetWindow(win(60, 4 * day), NOW);
  assert.deepEqual([plain.pace, plain.mode], [null, "steady"]);
});

test("Claude's critical warning stays out whatever the pace", () => {
  const w = budgetWindow(win(40, day, "critical"), NOW, undefined, WEEK);
  assert.equal(w.mode, "out");
});

test("the line says on pace only when pace moved the mode", () => {
  const b = buildBudget(limits({ seven_day: win(60, 4 * day) }), resolveConfig(null), NOW);
  assert.match(b.line, /week 60% tight \(on pace for 140%, resets in 4d\)/);
  assert.doesNotMatch(b.line, /5h [^·]*on pace/);
});

test("a slow Fable week near its reset frees Fable for planning", () => {
  const b = buildBudget(limits({ seven_day: win(40, day), fable: win(55, day) }), resolveConfig(null), NOW);
  assert.equal(b.fable.used_mode, "steady");
  assert.equal(b.fable.mode, "open");
  assert.match(b.line, /Fable 55% open \(on pace for 64%\)\. Plan fable high/);
});

test("a fast week tightens the Fable roles through the weekly mode", () => {
  // Week 70 % after 3 days is on pace for 163 %: steady by % used, tight by pace.
  const b = buildBudget(limits({ seven_day: win(70, 4 * day), fable: win(10, 4 * day) }), resolveConfig(null), NOW);
  assert.equal(b.seven_day.mode, "tight");
  assert.equal(b.roles.plan, "opus");
  assert.equal(b.effort.plan, "medium");
});

test("pace off gives the mode by % used alone", () => {
  const b = buildBudget(limits({ seven_day: win(60, 4 * day) }), resolveConfig({ pace: "off" }), NOW);
  assert.equal(b.seven_day.mode, "steady");
  assert.equal(b.seven_day.pace, null);
  assert.doesNotMatch(b.line, /on pace/);
});

test("the 5h window gets pace too", () => {
  const b = buildBudget(limits({ five_hour: win(40, 180) }), resolveConfig(null), NOW); // about 2 of 5 hours gone at the reading
  assert.equal(b.five_hour.pace, 102);
  assert.equal(b.five_hour.mode, "open");
  const fast = buildBudget(limits({ five_hour: win(70, 180) }), resolveConfig(null), NOW);
  assert.equal(fast.five_hour.mode, "tight");
  assert.match(fast.line, /5h 70% tight \(on pace for 178%, resets in 3h\)/);
});

test("pace steps that change nothing are undone", () => {
  // 5h open to steady: no advice changes.
  const b = buildBudget(limits({ five_hour: win(45, 180) }), resolveConfig(null), NOW);
  assert.equal(b.five_hour.pace, 114);
  assert.equal(b.five_hour.mode, "open");
  assert.doesNotMatch(b.line, /on pace/);
  // Week open to steady: the mechanical row is the same, so nothing changes.
  const w = buildBudget(limits({ seven_day: win(16, WEEK - 17 * 60) }), resolveConfig(null), NOW);
  assert.equal(w.seven_day.mode, "open");
  // With a different steady mechanical row, the step stays.
  const c = buildBudget(limits({ seven_day: win(16, WEEK - 17 * 60) }), resolveConfig({ roles: { steady: { mechanical: "haiku" } } }), NOW);
  assert.equal(c.seven_day.mode, "steady");
  assert.equal(c.roles.mechanical, "haiku");
  // Fable open to steady moves planning off Fable, so it stays.
  const f = buildBudget(limits({ fable: win(45, 5 * day) }), resolveConfig(null), NOW); // on pace for 157 %
  assert.equal(f.fable.mode, "steady");
  assert.equal(f.roles.plan, "opus");
});

// ---------- effort ----------

test("effort follows the same modes as the models", () => {
  assert.deepEqual(effortFor("open", "open"), DEFAULT_EFFORT.open);
  assert.equal(effortFor("open", "out").plan, "medium"); // a week out drives the Fable roles
  assert.equal(effortFor("open", "out").mechanical, "low");
  assert.equal(effortFor(null, null).plan, "high"); // fallback: Fable steady
});

test("effort settings merge per mode and role, bad values fall back", () => {
  const c = resolveConfig({ effort: { tight: { build: "high" }, calm: {}, open: { plan: "huge", nap: "low" } } });
  assert.equal(c.effort.tight.build, "high");
  assert.equal(c.effort.tight.plan, "medium");
  assert.equal(c.effort.open.plan, "high");
  assert.equal(c.problems.length, 3);
  assert.equal(resolveConfig({ effort: "high" }).problems.length, 1);
});

test("pace setting is checked", () => {
  assert.equal(resolveConfig({ pace: "off" }).pace, "off");
  assert.equal(resolveConfig(null).pace, "on");
  const c = resolveConfig({ pace: true });
  assert.equal(c.pace, "on");
  assert.match(c.problems[0], /pace must be on or off/);
});

test("the full config writes effort and pace out", () => {
  const f = fullConfig(resolveConfig(null));
  assert.deepEqual(Object.keys(f), ["_help", "thresholds", "delegate", "pace", "transcripts", "roles", "effort"]);
  assert.deepEqual(Object.keys(f.effort.out), ["plan", "build", "review", "final_check", "mechanical"]);
  assert.deepEqual(resolveConfig(f).problems, []);
});

test("config set takes effort and pace", () => {
  const raw = applySettings({}, ["effort.all.review=max", "effort.tight.build=high", "pace=off"]);
  assert.equal(raw.effort.open.review, "max");
  assert.equal(raw.effort.exhausted.review, "max");
  assert.equal(raw.effort.tight.build, "high");
  assert.equal(raw.pace, "off");
  assert.throws(() => applySettings({}, ["effort.all.review=huge"]), /effort must be low, medium, high, xhigh, max/);
  assert.throws(() => applySettings({}, ["effort.all.nap=low"]), /role must be/);
  assert.throws(() => applySettings({}, ["pace=maybe"]), /pace must be on or off/);
  assert.throws(() => applySettings({}, ["effort.review=low"]), /use effort\.<mode>\.<role>/);
  assert.throws(() => applySettings({}, ["effort.bogus.plan=high"]), /mode must be/);
});

// ---------- CLI ----------

const SCRIPT = fileURLToPath(new URL("../skills/agent-budget/scripts/budget.mjs", import.meta.url));
const cli = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, MODEL_BUDGET_DIR: dir, MODEL_BUDGET_CLAUDE: "/nonexistent/claude" } });

test("CLI show lists pace and the effort table; config set effort changes the line", () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-pace-"));
  const now = Date.now();
  writeAtomic(join(dir, "limits.json"), { version: 1, fetched_at: new Date(now).toISOString(), five_hour: { used: 10, resets_at: new Date(now + 120 * min).toISOString() }, seven_day: { used: 60, resets_at: new Date(now + 4 * day * min).toISOString() }, fable: { used: 10, resets_at: new Date(now + 4 * day * min).toISOString() }, last_error: null });
  let r = cli(dir, "show");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Pace: on/);
  assert.match(r.stdout, /week: 60 % used, on pace for 140 % at the reset \(steady by % used, tight by pace\)/);
  assert.match(r.stdout, /Subagent effort/);
  r = cli(dir, "config", "set", "effort.all.build=high");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /build opus high/);
  const f = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(f.effort.open.build, "high");
  assert.equal(f.pace, "on");
  r = cli(dir, "config", "set", "pace=off");
  assert.equal(r.status, 0, r.stderr);
  r = cli(dir, "show");
  assert.match(r.stdout, /Pace: off/);
  assert.doesNotMatch(r.stdout, /on pace for 140/);
});

test("a 1.0.0 config.json with no effort or pace loads clean and gains both on set", () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-old-"));
  const old = { _help: ["old"], thresholds: { steady: 50, tight: 75, out: 90 }, delegate: "bigger", roles: { open: { plan: "opus", build: "opus", review: "fable", final_check: "none", mechanical: "sonnet" } } };
  writeAtomic(join(dir, "config.json"), old);
  let r = cli(dir, "show");
  assert.doesNotMatch(r.stdout, /Problem:/);
  r = cli(dir, "config", "set", "thresholds.tight=80");
  assert.equal(r.status, 0, r.stderr);
  const f = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(f.roles.open.plan, "opus");
  assert.equal(f.pace, "on");
  assert.equal(f.effort.tight.plan, "medium");
});
