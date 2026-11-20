import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ROLES, DEFAULT_THRESHOLDS, budgetWindow, buildBudget, clean, modeFor, needsRefresh, parseLimits,
  fableRoleMode, readingStatus, resolveConfig, rolesFor, shortUntil, windowsFromUsage,
} from "../skills/agent-budget/scripts/core.mjs";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const min = 60_000;
const win = (used, inMin) => ({ used, resets_at: iso(NOW + inMin * min) });
const limits = (over = {}) => ({ version: 1, fetched_at: iso(NOW - 2 * min), five_hour: win(20, 120), seven_day: win(10, 6000), fable: win(10, 6000), last_error: null, ...over });

test("modes use the default thresholds", () => {
  assert.equal(modeFor(0), "open");
  assert.equal(modeFor(49), "open");
  assert.equal(modeFor(50), "steady");
  assert.equal(modeFor(75), "tight");
  assert.equal(modeFor(90), "out");
  assert.equal(modeFor(100), "exhausted");
  assert.equal(modeFor(10, "critical"), "out");
});

test("modes use custom thresholds", () => {
  const t = { steady: 30, tight: 60, out: 80 };
  assert.equal(modeFor(29, undefined, t), "open");
  assert.equal(modeFor(30, undefined, t), "steady");
  assert.equal(modeFor(60, undefined, t), "tight");
  assert.equal(modeFor(80, undefined, t), "out");
});

test("percent is rounded before picking the mode", () => {
  assert.equal(budgetWindow(win(89.6, 60), NOW).mode, "out");
  assert.equal(budgetWindow(win(89.6, 60), NOW).used, 90);
});

test("a window past its reset counts as 0 % open", () => {
  const w = budgetWindow(win(95, -5), NOW);
  assert.deepEqual([w.used, w.mode, w.resets_in_min], [0, "open", 0]);
});

test("no config means defaults with no problems", () => {
  const c = resolveConfig(null);
  assert.deepEqual(c.thresholds, DEFAULT_THRESHOLDS);
  assert.deepEqual(c.roles, DEFAULT_ROLES);
  assert.equal(c.delegate, "bigger");
  assert.deepEqual(c.problems, []);
});

test("partial config merges per mode and per role", () => {
  const c = resolveConfig({ thresholds: { tight: 80 }, roles: { open: { plan: "opus" } }, delegate: "always" });
  assert.deepEqual(c.thresholds, { steady: 50, tight: 80, out: 90 });
  assert.equal(c.roles.open.plan, "opus");
  assert.equal(c.roles.open.review, "fable");
  assert.deepEqual(c.roles.tight, DEFAULT_ROLES.tight);
  assert.equal(c.delegate, "always");
  assert.deepEqual(c.problems, []);
});

test("bad values fall back to defaults and are reported", () => {
  const c = resolveConfig({ roles: { open: { plan: "gpt", final_check: "none", nap: "opus" }, calm: {} }, delegate: "sometimes", extra: 1 });
  assert.equal(c.roles.open.plan, "fable");
  assert.equal(c.roles.open.final_check, "none");
  assert.equal(c.delegate, "bigger");
  assert.equal(c.problems.length, 5);
});

test("final_check accepts none, other roles do not", () => {
  assert.equal(resolveConfig({ roles: { open: { build: "none" } } }).problems.length, 1);
  assert.equal(resolveConfig({ roles: { open: { final_check: "none" } } }).problems.length, 0);
});

test("thresholds that do not rise fall back to all defaults", () => {
  const c = resolveConfig({ thresholds: { steady: 80, tight: 70 } });
  assert.deepEqual(c.thresholds, DEFAULT_THRESHOLDS);
  assert.equal(c.problems.length, 1);
});

test("thresholds outside 1 to 99 or not whole are rejected", () => {
  const c = resolveConfig({ thresholds: { steady: 0, tight: 75.5, out: 100 } });
  assert.deepEqual(c.thresholds, DEFAULT_THRESHOLDS);
  assert.equal(c.problems.length, 3);
});

test("a non-object config is reported", () => {
  assert.equal(resolveConfig([1]).problems.length, 1);
});

test("Fable mode drives plan/build/review/final check, weekly drives mechanical", () => {
  assert.deepEqual(rolesFor("open", "steady"), { plan: "fable", build: "opus", review: "fable", final_check: "none", mechanical: "sonnet" });
  assert.deepEqual(rolesFor("tight", "open"), { plan: "opus", build: "opus", review: "opus", final_check: "fable", mechanical: "sonnet" });
  // No reading: Fable steady, weekly open.
  assert.deepEqual(rolesFor(null, null), { plan: "opus", build: "opus", review: "fable", final_check: "none", mechanical: "sonnet" });
});

test("fresh reading gives a line that matches the roles", () => {
  const b = buildBudget(limits(), resolveConfig(null), NOW);
  assert.equal(b.status, "fresh");
  assert.equal(b.line, "Budget: 5h 20% open (resets in 2h) · week 10% open (resets in 4d4h) · Fable 10% open. Plan fable high, build opus medium, review fable high, mechanical sonnet low. Medium and large tasks: review in a subagent, and plan in one too when large, on these models.");
});

test("the line follows the config, not fixed wording", () => {
  const cfg = resolveConfig({ roles: { open: { plan: "sonnet", final_check: "opus" } }, delegate: "spawn_only" });
  const b = buildBudget(limits(), cfg, NOW);
  assert.match(b.line, /Plan sonnet high, build opus medium, review fable high, final check opus medium, mechanical sonnet low\.$/);
});

test("tight and out windows add advice", () => {
  const b = buildBudget(limits({ five_hour: win(80, 30), seven_day: win(92, 3000) }), resolveConfig(null), NOW);
  assert.match(b.line, /5h 80% tight \(resets in 30m\)/);
  assert.match(b.line, /mechanical haiku low/);
  assert.match(b.line, / No new parallel fan-outs\.$/);
  assert.doesNotMatch(b.line, /effort one level lower|Lowest subagent effort/);
});

test("a missing Fable window counts as steady and shows n/a", () => {
  const b = buildBudget(limits({ fable: null }), resolveConfig(null), NOW);
  assert.match(b.line, /Fable n\/a\. Plan opus high, build opus medium, review fable high/);
});

test("a stale reading uses the fallback and says how old it is", () => {
  const b = buildBudget(limits({ fetched_at: iso(NOW - 120 * min), last_error: { at: iso(NOW - min), message: "Claude Code did not answer within 30 s" } }), resolveConfig(null), NOW);
  assert.equal(b.status, "stale");
  assert.equal(b.five_hour, null);
  assert.equal(b.line, "Budget: reading is stale (last good reading 2 h ago; last check failed: Claude Code did not answer within 30 s). Fallback: Plan opus high, build opus medium, review fable high, mechanical sonnet low. Medium and large tasks: review in a subagent, and plan in one too when large, on these models. If this keeps happening, tell the user once, and offer to show the model budget.");
});

test("after a break, an old failed check is not repeated as news", () => {
  const b = buildBudget(limits({ fetched_at: iso(NOW - 300 * min), last_error: { at: iso(NOW - 200 * min), message: "offline" } }), resolveConfig(null), NOW);
  assert.match(b.line, /^Budget: reading is stale \(last good reading 5 h ago\)\. Fallback:/);
  assert.doesNotMatch(b.line, /offline|tell the user/);
});

test("no reading at all uses the fallback", () => {
  const b = buildBudget(null, resolveConfig(null), NOW);
  assert.equal(b.status, "none");
  assert.match(b.line, /^Budget: no usage reading yet\. Fallback: Plan opus/);
});

test("config problems are flagged in the line", () => {
  const b = buildBudget(limits(), resolveConfig({ roles: { open: { plan: "x" } } }), NOW);
  assert.match(b.line, /Settings have 1 problem, defaults used for them: tell the user once, and offer to show the model budget\.$/);
});

test("reading status and refresh timing", () => {
  assert.equal(readingStatus(null, NOW), "none");
  assert.equal(readingStatus(limits({ fetched_at: iso(NOW - 44 * min) }), NOW), "fresh");
  assert.equal(readingStatus(limits({ fetched_at: iso(NOW - 46 * min) }), NOW), "stale");
  assert.equal(needsRefresh(limits({ fetched_at: iso(NOW - 10 * min) }), NOW), false);
  assert.equal(needsRefresh(limits({ fetched_at: iso(NOW - 16 * min) }), NOW), true);
  assert.equal(needsRefresh(null, NOW), true);
  // A failed check less than 5 minutes ago: wait before trying again.
  assert.equal(needsRefresh(limits({ fetched_at: iso(NOW - 60 * min), last_error: { at: iso(NOW - 2 * min), message: "x" } }), NOW), false);
  assert.equal(needsRefresh(limits({ fetched_at: iso(NOW - 60 * min), last_error: { at: iso(NOW - 6 * min), message: "x" } }), NOW), true);
});

test("parseLimits rejects junk and keeps valid windows", () => {
  assert.equal(parseLimits(null), null);
  assert.equal(parseLimits({ version: 2 }), null);
  assert.equal(parseLimits({ version: 1, fetched_at: "nope" }), null);
  const l = parseLimits({ version: 1, fetched_at: iso(NOW), five_hour: { used: "50", resets_at: iso(NOW) }, seven_day: win(10, 5), fable: null });
  assert.equal(l.five_hour, null);
  assert.equal(l.seven_day.used, 10);
});

test("windowsFromUsage reads a get_usage answer", () => {
  const r = {
    five_hour: { utilization: 79, resets_at: iso(NOW + 15 * min) },
    seven_day: { utilization: 11, resets_at: iso(NOW + 6000 * min) },
    model_scoped: [{ display_name: "Fable", utilization: 12, resets_at: iso(NOW + 6000 * min) }],
    limits: [{ kind: "session", severity: "warning" }],
    spend: { secret: "dropped" },
  };
  const w = windowsFromUsage(r, null);
  assert.deepEqual(Object.keys(w), ["five_hour", "seven_day", "fable"]);
  assert.equal(w.five_hour.severity, "warning");
  assert.equal(w.fable.used, 12);
});

test("windowsFromUsage keeps the last Fable window when model_scoped is absent", () => {
  const prev = limits();
  const w = windowsFromUsage({ five_hour: { utilization: 5, resets_at: iso(NOW + min) } }, prev);
  assert.deepEqual(w.fable, prev.fable);
  assert.equal(windowsFromUsage({ model_scoped: [] , five_hour: { utilization: 5, resets_at: iso(NOW + min) } }, prev).fable, null);
  assert.equal(windowsFromUsage({}, null), null);
});

test("clean strips control characters and caps length", () => {
  assert.equal(clean("a\nb\u0007c"), "a b c");
  assert.equal(clean("x".repeat(700)).length, 600);
});

test("shortUntil formats", () => {
  assert.deepEqual([shortUntil(5), shortUntil(60), shortUntil(125), shortUntil(1440), shortUntil(1500)], ["5m", "1h", "2h05m", "1d", "1d1h"]);
});

test("a reading 15 to 45 minutes old shows its age", () => {
  const b = buildBudget(limits({ fetched_at: iso(NOW - 20 * min) }), resolveConfig(null), NOW);
  assert.match(b.line, /Fable 10% open\. Reading 20 min old\. Plan fable/);
  assert.doesNotMatch(buildBudget(limits(), resolveConfig(null), NOW).line, /min old/);
});

test("a carried-over Fable window is dropped once it is stale", () => {
  const old = limits({ fable_fetched_at: iso(NOW - 120 * min) });
  const b = buildBudget(old, resolveConfig(null), NOW);
  assert.match(b.line, /Fable n\/a\. Plan opus/);
  // Older files without fable_fetched_at use fetched_at.
  assert.equal(parseLimits({ ...limits(), fable_fetched_at: undefined }).fable_fetched_at, limits().fetched_at);
});

test("at 5h exhausted the line does not ask for subagents", () => {
  const b = buildBudget(limits({ five_hour: win(100, 30) }), resolveConfig(null), NOW);
  assert.doesNotMatch(b.line, /in subagents/);
  assert.match(b.line, /5h limit reached: start no new subagents\.$/);
});

test("threshold keys from the object prototype are rejected", () => {
  const c = resolveConfig({ thresholds: { constructor: 5, toString: 6 } });
  assert.equal(c.problems.length, 2);
  assert.deepEqual(c.thresholds, DEFAULT_THRESHOLDS);
});

test("a tight or worse week moves the Fable roles too", () => {
  assert.equal(fableRoleMode("open", "open"), "open");
  assert.equal(fableRoleMode("open", "steady"), "open");
  assert.equal(fableRoleMode("open", "tight"), "tight");
  assert.equal(fableRoleMode("open", "out"), "out");
  assert.equal(fableRoleMode("tight", "exhausted"), "exhausted");
  // Fable further along than the week: Fable decides.
  assert.equal(fableRoleMode("out", "tight"), "out");
  assert.equal(fableRoleMode("exhausted", "out"), "exhausted");
  // No Fable reading counts as steady.
  assert.equal(fableRoleMode(null, "tight"), "tight");
  assert.equal(fableRoleMode(null, null), "steady");
  assert.deepEqual(rolesFor("open", "out"), { plan: "opus", build: "opus", review: "opus", final_check: "fable", mechanical: "haiku" });
});

test("the line for week 95 % and Fable 10 % has no Fable planning", () => {
  const b = buildBudget(limits({ seven_day: win(95, 3000), fable: win(10, 3000) }), resolveConfig(null), NOW);
  assert.match(b.line, /week 95% out .* Fable 10% open\. Plan opus medium, build opus low, review opus medium, final check fable low, mechanical haiku low\./);
});
