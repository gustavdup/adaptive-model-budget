// Tests for the fixes from the final review: failed checks in a row, the stale fallback, odd drops in
// the line, odd jumps and early resets in the history, plan changes, pace hysteresis, the scan stop,
// config set with old problems, and run.log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeEnv, tempDir } from "./safe-env.mjs";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCKS, WEEK_MS, emptyHistory, parseHistory, recordReading } from "../skills/agent-budget/scripts/history.mjs";
import { budgetWindow, buildBudget, holdDrops, parseLimits, resolveConfig } from "../skills/agent-budget/scripts/core.mjs";
import { fetchLimits } from "../skills/agent-budget/scripts/fetch.mjs";
import { loadHistory, loadLimits, refresh, tidyLog, writeAtomic } from "../skills/agent-budget/scripts/budget.mjs";

process.env.TZ = "UTC";
const UTC = () => 0;
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
const tmp = () => tempDir("mb-r4-");
const sum = (a) => a.reduce((s, x) => s + x, 0);
const RESET = Date.parse("2026-11-19T04:00:00Z");
const NEXT = RESET + WEEK_MS;
const NOW = RESET + 3 * D;
const SCRIPT = join(fileURLToPath(new URL("../skills/agent-budget/scripts/", import.meta.url)), "budget.mjs");
const cli = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: safeEnv(dir) });
const win = (used, resetMs) => ({ used, resets_at: iso(resetMs) });
const limits = (over = {}) => ({ version: 1, fetched_at: iso(NOW - 2 * MIN), fable_fetched_at: iso(NOW - 2 * MIN), five_hour: win(20, NOW + 2 * H), seven_day: win(10, NEXT), fable: win(10, NEXT), last_error: null, ...over });
const cfg = resolveConfig(null);

// ---------- failed checks ----------

test("failed checks are counted in a row, and a success clears the count", async () => {
  const fail = async () => {
    throw new Error("offline");
  };
  const one = await fetchLimits(limits(), { claude: "/x", now: () => NOW, ask: fail });
  assert.equal(one.file.last_error.count, 1);
  const two = await fetchLimits(parseLimits(one.file), { claude: "/x", now: () => NOW + 20 * MIN, ask: fail });
  assert.equal(two.file.last_error.count, 2);
  const ok = await fetchLimits(parseLimits(two.file), { claude: "/x", now: () => NOW + 40 * MIN, ask: async () => ({ seven_day: { utilization: 11, resets_at: iso(NEXT) } }) });
  assert.equal(ok.file.last_error, null);
  // A file from before 1.2.3 has no count: it is one.
  assert.equal(parseLimits(limits({ last_error: { at: iso(NOW), message: "x" } })).last_error.count, 1);
});

test("two failures in a row are shown at any age, with the instruction to tell the user", () => {
  const err = (count, agoMin) => ({ at: iso(NOW - agoMin * MIN), message: "could not find the claude command", count });
  const stale = buildBudget(limits({ fetched_at: iso(NOW - 70 * MIN), last_error: err(2, 25) }), cfg, NOW);
  assert.match(stale.line, /the last 2 checks failed: could not find the claude command/);
  assert.match(stale.line, /Checks keep failing: tell the user once, and offer to show the model budget\.$/);
  // One failure, 25 minutes old: not news.
  const once = buildBudget(limits({ fetched_at: iso(NOW - 70 * MIN), last_error: err(1, 25) }), cfg, NOW);
  assert.doesNotMatch(once.line, /failed|tell the user/);
  // A reading 20 minutes old (still trusted) also says so once checks keep failing.
  const fresh = buildBudget(limits({ fetched_at: iso(NOW - 20 * MIN), last_error: err(3, 2) }), cfg, NOW);
  assert.match(fresh.line, /Reading 20 min old; the last 3 checks failed: .*Checks keep failing: tell the user once/);
  // No reading at all.
  const none = buildBudget({ ...limits(), fetched_at: null, five_hour: null, seven_day: null, fable: null, last_error: err(2, 30) }, cfg, NOW);
  assert.match(none.line, /^Budget: no usage reading yet; the last 2 checks failed/);
});

// ---------- stale fallback ----------

test("a stale fallback is never looser than the last reading in a window that has not reset", () => {
  const l = limits({ fetched_at: iso(NOW - 15 * H), seven_day: win(90, NOW + 2 * H), fable: win(77, NOW + 2 * H), five_hour: null });
  const b = buildBudget(l, cfg, NOW);
  assert.equal(b.status, "stale");
  assert.match(b.line, /last good reading 15 h ago: week 90%, Fable 77%\)/);
  assert.deepEqual(b.roles, { plan: "opus", build: "opus", review: "opus", final_check: "fable", mechanical: "haiku" });
  // Once those windows have reset, the plain fallback applies again.
  const later = buildBudget(l, cfg, NOW + 3 * H);
  assert.deepEqual(later.roles, { plan: "opus", build: "opus", review: "fable", final_check: "none", mechanical: "sonnet" });
  // A 5h window still exhausted keeps its advice.
  const five = buildBudget(limits({ fetched_at: iso(NOW - 50 * MIN), five_hour: win(100, NOW + H) }), cfg, NOW);
  assert.match(five.line, /5h limit reached: start no new subagents\./);
  assert.doesNotMatch(five.line, /Medium and large tasks/);
});

// ---------- odd drops in the line ----------

test("one odd low answer does not loosen the line; a second one confirms it", () => {
  const prev = parseLimits(limits({ seven_day: win(81, NEXT) }));
  const odd = holdDrops(prev, limits({ seven_day: win(3, NEXT) }), NOW);
  assert.equal(odd.seven_day.used, 81);
  assert.deepEqual(odd.held, { seven_day: 3 });
  const back = holdDrops(parseLimits(odd), limits({ seven_day: win(82, NEXT) }), NOW);
  assert.equal(back.seven_day.used, 82);
  assert.equal(back.held, undefined);
  const real = holdDrops(parseLimits(odd), limits({ seven_day: win(4, NEXT) }), NOW);
  assert.equal(real.seven_day.used, 4);
  assert.equal(real.held, undefined);
  // A window that has reset, or a reset time that moved, is a new window: no hold.
  assert.equal(holdDrops(prev, limits({ seven_day: win(3, NEXT + WEEK_MS) }), NOW).seven_day.used, 3);
  // A wobble of 2 is not held.
  assert.equal(holdDrops(prev, limits({ seven_day: win(79, NEXT) }), NOW).held, undefined);
});

test("refresh holds the drop in the line but gives the history the % as read", async () => {
  const dir = tmp();
  const at = (used, t) => async () => ({ ok: true, file: holdDrops(loadLimits(dir), { version: 1, fetched_at: iso(t), fable_fetched_at: null, five_hour: null, seven_day: win(used, NEXT), fable: null, last_error: null }, t) });
  await refresh(dir, { force: true, now: () => NOW, fetch: at(60, NOW) });
  const r = await refresh(dir, { force: true, now: () => NOW + 20 * MIN, fetch: at(12, NOW + 20 * MIN) });
  assert.match(r.budget.line, /week 60%/);
  assert.equal(loadLimits(dir).held.seven_day, 12);
  assert.equal(loadHistory(dir).last.held, 12);
});

// ---------- the history ----------

const read = (h, at, used, reset = NEXT) => recordReading(h, { at: iso(at), used, resets_at: iso(reset) }, UTC);

test("a second reading must be near the held one to confirm it", () => {
  let h = read(null, NOW, 60);
  for (const [i, u] of [12, 57, 60].entries()) h = read(h, NOW + (i + 1) * H, u);
  assert.equal(sum(h.current.v), 0, "60, 12, 57, 60 records nothing");
  let g = read(null, NOW, 30);
  for (const [i, u] of [31, 75, 31, 32].entries()) g = read(g, NOW + (i + 1) * H, u);
  assert.equal(sum(g.current.v), 2, "an odd high (30, 31, 75, 31, 32) records only the 2 real points");
  let j = read(null, NOW, 30);
  for (const [i, u] of [45, 47].entries()) j = read(j, NOW + (i + 1) * H, u);
  assert.equal(sum(j.current.v), 17, "a real jump is counted once confirmed");
});

test("a held reading keeps the time since the last good one, so a gap is still seen", () => {
  const evening = NOW + 20 * H - 3 * D + 3 * D; // Sunday 20:00 UTC
  let h = read(null, evening, 60);
  h = read(h, evening + 12 * H, 12); // next morning: held
  assert.equal(h.last.at, iso(evening));
  h = read(h, evening + 12 * H + 15 * MIN, 13); // confirms
  const seen = h.current.c.filter((c) => c > 0).length;
  assert.ok(seen >= 4, `the overnight blocks are seen (${seen})`);
});

test("a confirmed drop with a moved reset time starts a new week", () => {
  let h = read(null, NOW, 60);
  h = read(h, NOW + H, 1, NEXT - 2 * D);
  h = read(h, NOW + 2 * H, 2, NEXT - 2 * D);
  assert.equal(h.current.reset, iso(NEXT - 2 * D));
  assert.equal(h.weeks.length, 1);
  assert.ok(sum(h.current.v) <= 2);
});

test("a plan change scales the older weeks to the new plan", () => {
  const week = { v: new Array(BLOCKS).fill(1), c: new Array(BLOCKS).fill(1) };
  let h = { ...emptyHistory(), weeks: [week, structuredClone(week)] };
  h = read(h, NOW, 60);
  h.current.v[0] = 10;
  h = read(h, NOW + H, 12);
  h = read(h, NOW + 2 * H, 13);
  assert.equal(h.weeks[0].v[5], 0.2);
  assert.equal(h.current.v[0], 2);
  // A drop to near nothing is a usage reset, not a plan change: no scaling.
  let k = { ...emptyHistory(), weeks: [structuredClone(week)] };
  k = read(k, NOW, 60);
  k = read(k, NOW + H, 0);
  k = read(k, NOW + 2 * H, 1);
  assert.equal(k.weeks[0].v[5], 1);
});

test("a held reading from 1.2.2 (last.low) is read as held", () => {
  const h = parseHistory({ version: 1, last: { at: iso(NOW), used: 60, resets_at: iso(NEXT), low: 12 }, current: { reset: iso(NEXT), v: new Array(BLOCKS).fill(0), c: new Array(BLOCKS).fill(0) }, weeks: [] });
  assert.equal(h.last.held, 12);
});

// ---------- pace hysteresis ----------

test("once pace has moved a window tighter, it stays so until pace is well under the bar", () => {
  // Weekly straight line: bar 130. Half the week gone: 62 % used is on pace for 124 %.
  const w = win(62, NOW + 3.5 * D);
  const args = (was) => budgetWindow(w, NOW, cfg.thresholds, 7 * 24 * 60, NOW, 130, null, was);
  assert.equal(args(false).mode, "steady");
  assert.equal(args(true).mode, "tight");
  assert.equal(budgetWindow(win(55, NOW + 3.5 * D), NOW, cfg.thresholds, 7 * 24 * 60, NOW, 130, null, true).mode, "steady", "110 % is under the held bar of 120");
});

test("refresh notes which windows pace moved tighter", async () => {
  const dir = tmp();
  const t = RESET + 3.5 * D;
  const fetch = (used) => async () => ({ ok: true, file: { version: 1, fetched_at: iso(t), fable_fetched_at: null, five_hour: null, seven_day: win(used, NEXT), fable: null, last_error: null } });
  await refresh(dir, { force: true, now: () => t, fetch: fetch(70) });
  assert.equal(loadLimits(dir).paced.seven_day, iso(NEXT));
});

// ---------- scan, config, line, log ----------

test("the transcript scan stops once there are 2 good weeks of readings", async () => {
  const dir = tmp();
  writeAtomic(join(dir, "config.json"), { transcripts: "on" });
  const full = { v: new Array(BLOCKS).fill(0.5), c: new Array(BLOCKS).fill(1) };
  writeAtomic(join(dir, "history.json"), { ...emptyHistory(), weeks: [full, structuredClone(full)] });
  let scans = 0;
  const scanner = async () => {
    scans++;
    return { shares: null };
  };
  await refresh(dir, { force: true, scan: true, scanner, now: () => NOW, fetch: async () => ({ ok: true, file: limits({ fetched_at: iso(NOW) }) }) });
  assert.equal(scans, 0);
});

test("the day note says 1 point, not 1 points", () => {
  const week = { v: new Array(BLOCKS).fill(0), c: new Array(BLOCKS).fill(1) };
  for (let b = 0; b < BLOCKS; b++) week.v[b] = 3;
  const t = RESET + 4 * D + 13 * H; // Monday 17:00 UTC: today is Monday
  const cur = { reset: iso(NEXT), v: new Array(BLOCKS).fill(0), c: new Array(BLOCKS).fill(1) };
  cur.v[1 * 6] = 1;
  const h = { ...emptyHistory(), weeks: [week, structuredClone(week)], current: cur };
  const b = buildBudget(limits({ fetched_at: iso(t), seven_day: win(40, NEXT), five_hour: null, fable: null }), cfg, t, h);
  assert.match(b.line, /Quiet day: 1 point of the week used today/);
});

test("config set works with an old unknown key, and removes it", () => {
  const dir = tmp();
  writeFileSync(join(dir, "config.json"), JSON.stringify({ colour: "blue", delegate: "bigger" }));
  const r = cli(dir, "config", "set", "delegate=always");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Fixed 1 bad setting/);
  const saved = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(saved.colour, undefined);
  assert.equal(saved.delegate, "always");
  // A new bad value still stops it.
  assert.notEqual(cli(dir, "config", "set", "delegate=sometimes").status, 0);
});

test("run.log is kept private and cut back to whole lines", () => {
  const dir = tmp();
  const log = join(dir, "run.log");
  writeFileSync(log, Array.from({ length: 4000 }, (_, i) => `2026-11-20T00:00:00Z ok line ${i}`).join("\n") + "\n");
  chmodSync(log, 0o644);
  tidyLog(dir);
  const st = statSync(log);
  assert.equal(st.mode & 0o777, 0o600);
  assert.ok(st.size <= 16 * 1024);
  const text = readFileSync(log, "utf8");
  assert.match(text, /^2026-11-20T00:00:00Z ok line \d+\n/);
  assert.match(text, /line 3999\n$/);
});
