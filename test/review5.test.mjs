// Tests for the fixes from the review of 1.2.3: rescaling only for a real plan change, the stale
// fallback keeping a pace step, reset times that differ slightly, the line cap, a carried Fable
// window, a held jump at the week rollover, and failures after a long break.
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeEnv, tempDir } from "./safe-env.mjs";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCKS, WEEK_MS, emptyHistory, recordReading } from "../skills/agent-budget/scripts/history.mjs";
import { buildBudget, holdDrops, parseLimits, resolveConfig } from "../skills/agent-budget/scripts/core.mjs";

process.env.TZ = "UTC";
const UTC = () => 0;
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
const sum = (a) => a.reduce((s, x) => s + x, 0);
const RESET = Date.parse("2026-11-19T04:00:00Z");
const NEXT = RESET + WEEK_MS;
const NOW = RESET + 3 * D;
const SCRIPT = join(fileURLToPath(new URL("../skills/agent-budget/scripts/", import.meta.url)), "budget.mjs");
const cli = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: safeEnv(dir) });
const win = (used, resetMs) => ({ used, resets_at: iso(resetMs) });
const limits = (over = {}) => ({ version: 1, fetched_at: iso(NOW - 2 * MIN), fable_fetched_at: iso(NOW - 2 * MIN), five_hour: win(20, NOW + 2 * H), seven_day: win(10, NEXT), fable: win(10, NEXT), last_error: null, ...over });
const cfg = resolveConfig(null);
const read = (h, at, used, reset = NEXT) => recordReading(h, { at: iso(at), used, resets_at: iso(reset) }, UTC);
const week = () => ({ v: new Array(BLOCKS).fill(1), c: new Array(BLOCKS).fill(1) });

test("only a real plan change rescales the stored weeks", () => {
  const run = (...used) => {
    let h = { ...emptyHistory(), weeks: [week(), week()] };
    for (const [i, u] of used.entries()) h = read(h, NOW + i * H, u);
    return h.weeks[0].v[5];
  };
  assert.equal(run(60, 12, 13), 0.2, "60 to 12: a bigger plan");
  assert.equal(run(8, 1, 2), 1, "a usage wipe to a small % is not scaled");
  assert.equal(run(30, 3, 4), 1, "3 % is too rough to scale by");
  assert.equal(run(60, 58, 56, 56), 1, "a slow dip is not a new plan");
});

test("a stale fallback keeps the step that pace had added", () => {
  // The fresh line had week 60 % tight by pace; the reading is now 50 minutes old.
  const l = limits({ fetched_at: iso(NOW - 50 * MIN), seven_day: win(60, NEXT), paced: { seven_day: iso(NEXT) } });
  const b = buildBudget(parseLimits(l), cfg, NOW);
  assert.equal(b.status, "stale");
  assert.equal(b.roles.review, "opus");
  assert.equal(b.roles.final_check, "fable");
  // With pace off, the step is not kept.
  assert.equal(buildBudget(parseLimits(l), resolveConfig({ pace: "off" }), NOW).roles.review, "fable");
});

test("pace hysteresis holds when the reset time differs slightly between answers", () => {
  const t = RESET + 3.5 * D;
  // 62 % at half the week is on pace for 124 %: tight only when pace had already tightened it.
  const l = limits({ fetched_at: iso(t), seven_day: win(62, NEXT + 137), five_hour: null, fable: null, paced: { seven_day: iso(NEXT) } });
  assert.match(buildBudget(parseLimits(l), cfg, t).line, /week 62% tight/);
});

test("the instruction to tell the user survives the line cap", () => {
  const raw = { colour: "blue", thresholds: { tight: 200 } };
  const c = resolveConfig(raw);
  assert.equal(c.problems.length, 2);
  const err = { at: iso(NOW - 2 * MIN), message: `could not find the claude command at /Users/someone/with/a/very/long/path/${"x".repeat(150)}/claude (set MODEL_BUDGET_CLAUDE to its full path)`, count: 2 };
  const l = limits({ fetched_at: iso(NOW - 70 * MIN), five_hour: win(95, NOW + H), last_error: err });
  const b = buildBudget(parseLimits(l), c, NOW);
  assert.ok(b.line.length < 600, `${b.line.length} characters`);
  assert.match(b.line, /5h nearly out/);
  assert.match(b.line, /Settings have 2 problems, defaults used for them, and checks keep failing: tell the user once, and offer to show the model budget\.$/);
});

test("a Fable window carried over from the last answer keeps its hold", () => {
  const prev = parseLimits(limits({ fable: win(50, NEXT), held: { fable: 10 } }));
  const next = { ...limits(), fable: prev.fable };
  const out = holdDrops(prev, next, NOW);
  assert.equal(out.fable.used, 50);
  assert.deepEqual(out.held, { fable: 10 });
});

test("a held jump still counts when the week rolls over before it is confirmed", () => {
  let h = read(null, NEXT - 10 * H, 30);
  h = read(h, NEXT - 2 * H, 45); // held
  h = read(h, NEXT + 2 * H, 3, NEXT + WEEK_MS); // the new week
  assert.equal(sum(h.weeks[0].v), 15);
  assert.equal(sum(h.current.v), 3);
});

test("failures in a row from last night wait for the first retry", () => {
  const err = { at: iso(NOW - 10 * H), message: "offline", count: 4 };
  const b = buildBudget(parseLimits(limits({ fetched_at: iso(NOW - 12 * H), last_error: err })), cfg, NOW);
  assert.doesNotMatch(b.line, /failed|tell the user/);
});

test("config init fixes old problems instead of refusing", () => {
  const dir = tempDir("mb-r5-");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ colour: "blue", delegate: "always" }));
  const r = cli(dir, "config", "init");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Fixed 1 bad setting/);
  const saved = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(saved.colour, undefined);
  assert.equal(saved.delegate, "always");
});
