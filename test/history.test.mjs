import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOCKS, BLOCK_MS, WEEK_MS, blockIndex, dayCheck, emptyHistory, goodWeeks, parseHistory, patternPace, patternShares,
  pieces, recordReading, shareBetween, sharesFromEvents,
} from "../skills/agent-budget/scripts/history.mjs";
import { eventFromLine, scanTranscripts, transcriptFiles } from "../skills/agent-budget/scripts/transcripts.mjs";
import { buildBudget, resolveConfig } from "../skills/agent-budget/scripts/core.mjs";
import { OWN_FILES, loadHistory, refresh, writeAtomic } from "../skills/agent-budget/scripts/budget.mjs";
import { SCRIPT_FILES } from "../skills/agent-budget/scripts/job.mjs";

// Everything here runs in UTC, so blocks are the same on every machine.
process.env.TZ = "UTC";
const UTC = () => 0;
const H = 3_600_000;
const D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
// Thursday 2026-11-19 04:00 UTC: a weekly reset, like the real one.
const RESET = Date.parse("2026-11-19T04:00:00Z");
const NEXT = RESET + WEEK_MS;

/** A week where use falls only on weekdays 08:00 to 20:00: `perBlock` points in each of those blocks. */
function workWeek(perBlock = 2) {
  const v = new Array(BLOCKS).fill(0);
  for (let day = 1; day <= 5; day++) for (const b of [2, 3, 4]) v[day * 6 + b] = perBlock;
  return { v, c: new Array(BLOCKS).fill(1) };
}
const historyWith = (weeks, current = null) => ({ ...emptyHistory(), weeks, current: current ?? { reset: iso(NEXT), v: new Array(BLOCKS).fill(0), c: new Array(BLOCKS).fill(1) } });

// ---------- blocks ----------

test("blocks are 4 hours, Sunday 00:00 first", () => {
  assert.equal(blockIndex(Date.parse("2026-11-22T00:00:00Z"), UTC), 0); // Sunday
  assert.equal(blockIndex(Date.parse("2026-11-19T05:00:00Z"), UTC), 4 * 6 + 1); // Thursday 04:00 to 08:00
  assert.equal(blockIndex(Date.parse("2026-11-21T23:59:00Z"), UTC), 41); // Saturday night
  assert.equal(blockIndex(Date.parse("2026-11-22T01:00:00Z"), () => 2 * H), 0); // local 03:00 Sunday
});

test("pieces split time at block edges", () => {
  const p = pieces(Date.parse("2026-11-19T07:00:00Z"), Date.parse("2026-11-19T09:00:00Z"), UTC);
  assert.deepEqual(p, [{ block: 25, ms: H }, { block: 26, ms: H }]);
});

// ---------- recording readings ----------

test("the first reading starts the record; later rises are spread over the time between", () => {
  let h = recordReading(null, { at: iso(RESET + 2 * D + 9 * H), used: 20, resets_at: iso(NEXT) }, UTC);
  assert.equal(h.current.v.reduce((s, x) => s + x, 0), 0);
  assert.equal(h.last.used, 20);
  h = recordReading(h, { at: iso(RESET + 2 * D + 11 * H), used: 24, resets_at: iso(NEXT) }, UTC);
  // Saturday 13:00 to 15:00 UTC is all in block 6*6+3.
  assert.equal(h.current.v[39], 4);
  assert.equal(h.current.c[39], 1);
  assert.equal(h.current.c[38], 0);
});

test("a drop adds nothing, a repeated or older reading changes nothing", () => {
  let h = recordReading(null, { at: iso(RESET + D), used: 20, resets_at: iso(NEXT) }, UTC);
  h = recordReading(h, { at: iso(RESET + D + H), used: 19, resets_at: iso(NEXT) }, UTC);
  assert.equal(h.current.v.reduce((s, x) => s + x, 0), 0);
  const same = recordReading(h, { at: iso(RESET + D), used: 50, resets_at: iso(NEXT) }, UTC);
  assert.deepEqual(same, h);
});

test("a reset jitter of a second is the same week", () => {
  let h = recordReading(null, { at: iso(RESET + D), used: 20, resets_at: "2026-11-26T04:00:00.469Z" }, UTC);
  h = recordReading(h, { at: iso(RESET + D + H), used: 22, resets_at: "2026-11-26T03:59:59.595Z" }, UTC);
  assert.equal(h.weeks.length, 0);
  assert.equal(h.current.v.reduce((s, x) => s + x, 0), 2);
});

test("a new reset closes the week and spreads the new % from the reset", () => {
  let h = recordReading(null, { at: iso(RESET - 2 * H), used: 80, resets_at: iso(RESET) }, UTC);
  h = recordReading(h, { at: iso(RESET - H), used: 81, resets_at: iso(RESET) }, UTC);
  h = recordReading(h, { at: iso(RESET + 4 * H), used: 4, resets_at: iso(NEXT) }, UTC);
  assert.equal(h.weeks.length, 1);
  assert.equal(h.weeks[0].v.reduce((s, x) => s + x, 0), 1);
  assert.equal(h.current.reset, iso(NEXT));
  assert.equal(h.current.v[25], 4); // Thursday 04:00 to 08:00
});

test("a rise over a long gap counts as half seen, so one reading a day never makes a good week", () => {
  let h = emptyHistory();
  for (let d = 0; d <= 21; d++) h = recordReading(h, { at: iso(RESET - 2 * WEEK_MS + d * D + 12 * H), used: ((d % 7) + 1) * 10, resets_at: iso(RESET - 2 * WEEK_MS + Math.floor(d / 7 + 1) * WEEK_MS) }, UTC);
  assert.ok(h.weeks.length >= 2);
  assert.equal(goodWeeks(h).length, 0);
});

test("a quiet stretch before the reset still counts the week as seen", () => {
  // Weekdays 09:00 to 18:00 only, a reading every 15 min; nothing from Friday 18:00 to the Thursday reset.
  let h = emptyHistory();
  let used = 0;
  const start = RESET - 3 * WEEK_MS;
  for (let t = start + 15 * 60_000; t < RESET + H; t += 15 * 60_000) {
    const d = new Date(t);
    const work = d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && d.getUTCHours() >= 9 && d.getUTCHours() < 18;
    if (!work) continue;
    const reset = start + Math.ceil((t - start) / WEEK_MS) * WEEK_MS;
    if (Math.floor((t - start) / WEEK_MS) !== Math.floor((t - start - 15 * 60_000) / WEEK_MS)) used = 0;
    used += 0.2;
    h = recordReading(h, { at: iso(t), used: Math.round(used), resets_at: iso(reset) }, UTC);
  }
  assert.ok(goodWeeks(h).length >= 2, `good weeks: ${goodWeeks(h).length}`);
});

test("a rounding wobble does not count twice", () => {
  let h = recordReading(null, { at: iso(RESET + D), used: 20, resets_at: iso(NEXT) }, UTC);
  for (const [i, used] of [19, 20, 19, 20].entries()) h = recordReading(h, { at: iso(RESET + D + (i + 1) * H), used, resets_at: iso(NEXT) }, UTC);
  assert.equal(h.current.v.reduce((s, x) => s + x, 0), 0);
});

test("a reset time that moves mid-week is the same week", () => {
  let h = recordReading(null, { at: iso(RESET + D), used: 50, resets_at: iso(NEXT) }, UTC);
  h = recordReading(h, { at: iso(RESET + D + H), used: 52, resets_at: iso(NEXT + 2 * D) }, UTC);
  assert.equal(h.weeks.length, 0);
  assert.equal(h.current.v.reduce((s, x) => s + x, 0), 2);
});

test("a clock set back a long way restarts from the new time", () => {
  let h = recordReading(null, { at: iso(RESET + 3 * D), used: 20, resets_at: iso(NEXT) }, UTC);
  h = recordReading(h, { at: iso(RESET + D), used: 21, resets_at: iso(NEXT) }, UTC);
  assert.equal(h.last.at, iso(RESET + D));
  h = recordReading(h, { at: iso(RESET + D + H), used: 23, resets_at: iso(NEXT) }, UTC);
  assert.equal(h.current.v.reduce((s, x) => s + x, 0), 2);
});

test("only 6 weeks are kept", () => {
  let h = emptyHistory();
  let at = RESET - 7 * WEEK_MS;
  for (let w = 0; w < 9; w++) {
    const reset = at + WEEK_MS;
    for (let i = 1; i <= 42; i++) h = recordReading(h, { at: iso(at + i * BLOCK_MS - H), used: i, resets_at: iso(reset) }, UTC);
    at = reset;
  }
  assert.equal(h.weeks.length, 6);
  assert.ok(JSON.stringify(h).length < 16 * 1024, `history is ${JSON.stringify(h).length} bytes`);
});

test("a bad history file starts fresh", () => {
  assert.deepEqual(parseHistory({ version: 2 }), emptyHistory());
  assert.deepEqual(parseHistory(null), emptyHistory());
  const h = parseHistory({ version: 1, weeks: [{ v: [1], c: [1] }, workWeek()], current: { reset: "x", v: [], c: [] } });
  assert.equal(h.weeks.length, 1);
  assert.equal(h.current.reset, null);
});

// ---------- pattern ----------

test("the readings pattern needs 2 good weeks", () => {
  assert.equal(patternShares(historyWith([workWeek()])), null);
  const half = { v: workWeek().v, c: new Array(BLOCKS).fill(0).map((_, i) => (i < 20 ? 1 : 0)) };
  assert.equal(goodWeeks(historyWith([workWeek(), half])).length, 1);
  const p = patternShares(historyWith([workWeek(), workWeek(3)]));
  assert.equal(p.source, "readings");
  assert.ok(Math.abs(p.shares.reduce((s, x) => s + x, 0) - 1) < 1e-9);
  assert.ok(p.shares[0] > 0, "an empty block still gets a little time");
});

test("the transcript pattern fills in until then, only when the scan is on", () => {
  const h = { ...historyWith([workWeek()]), transcripts: { scanned_at: iso(RESET), shares: workWeek(1 / 45).v } };
  assert.equal(patternShares(h), null);
  assert.equal(patternShares(h, { transcripts: true }).source, "transcripts");
});

test("one odd week barely moves the pattern (median)", () => {
  const odd = workWeek();
  odd.v[0] = 40; // one night of heavy use
  const p = patternShares(historyWith([workWeek(), workWeek(), odd]));
  const plain = patternShares(historyWith([workWeek(), workWeek(), workWeek()]));
  assert.deepEqual(p.shares, plain.shares);
});

test("with weekday-only use, Friday evening is mostly through the week", () => {
  const { shares } = patternShares(historyWith([workWeek(), workWeek()]));
  // Week from Thursday 19 November 04:00. Friday 20 November 20:00: a straight line says 1.7 of 7
  // days gone, so 30 % is on pace for 124 %. With weekday-only use, 6 of 15 work blocks are done
  // and the weekend is quiet, so the pattern says about 80 %.
  const fri20 = Date.parse("2026-11-20T20:00:00Z");
  const pace = patternPace(30, NEXT, fri20, 7 * 24 * 60, shares, null, UTC);
  assert.ok(pace < 90 && pace > 70, `pace ${pace}`);
  // Wednesday 25 November 20:00, the last work evening: 75 % is on pace for under 80 %.
  const wed20 = Date.parse("2026-11-25T20:00:00Z");
  assert.ok(patternPace(75, NEXT, wed20, 7 * 24 * 60, shares, null, UTC) < 80);
});

test("pattern pace is null until 10 % of a usual week has gone", () => {
  const { shares } = patternShares(historyWith([workWeek(), workWeek()]));
  // Thursday 04:00 to Thursday 08:00: almost nothing of a usual week.
  assert.equal(patternPace(2, NEXT, RESET + 4 * H, 7 * 24 * 60, shares, null, UTC), null);
});

test("shareBetween covers a whole week as 1", () => {
  const { shares } = patternShares(historyWith([workWeek(), workWeek()]));
  assert.ok(Math.abs(shareBetween(shares, RESET, NEXT, UTC) - 1) < 1e-9);
});

// ---------- day check ----------

/** Current week with `points` used today (Monday 23 November) by 14:00 UTC. */
function today(points) {
  const v = new Array(BLOCKS).fill(0);
  v[1 * 6 + 2] = points / 2; // Monday 08:00 to 12:00
  v[1 * 6 + 3] = points / 2; // Monday 12:00 to 16:00
  return { reset: iso(NEXT), v, c: new Array(BLOCKS).fill(1) };
}
const MON14 = Date.parse("2026-11-23T14:00:00Z");

test("a heavy day is flagged, with a factor for the rest of today", () => {
  const h = historyWith([workWeek(), workWeek(), workWeek()], today(12));
  const d = dayCheck(h, MON14, UTC);
  assert.equal(d.kind, "heavy");
  assert.equal(d.typical, 3); // 2 points by 12:00 and half of the next block's 2
  assert.equal(d.actual, 12);
  // Usual band 2 to 4, heavy from 4 + 3 = 7: the factor grows from 1 there.
  assert.equal(d.factor, 1.71);
});

test("the day factor grows smoothly, with no jump at the edge", () => {
  const weeks = [workWeek(), workWeek(), workWeek()];
  const f = (pts) => dayCheck(historyWith(weeks, today(pts)), MON14, UTC).factor;
  assert.equal(f(6.9), 1);
  assert.equal(f(7), 1);
  assert.ok(f(8) > 1 && f(8) < 1.2, `factor ${f(8)}`);
  assert.equal(f(100), 3);
});

test("early in a work block, nothing used yet is not a quiet day", () => {
  // 6 points per work block, Monday 10:00, 0 used: the band runs from 0 (by 08:00) to 6.
  const h = historyWith([workWeek(6), workWeek(6), workWeek(6)], { reset: iso(NEXT), v: new Array(BLOCKS).fill(0), c: new Array(BLOCKS).fill(1) });
  const d = dayCheck(h, Date.parse("2026-11-23T10:00:00Z"), UTC);
  assert.equal(d.kind, "usual");
  assert.equal(d.factor, 1);
});

test("ordinary days that vary by half are not flagged", () => {
  const weeks = [workWeek(4), workWeek(4), workWeek(4)];
  // Usual by now is 6 (band 4 to 8). Half more or less is not flagged; double is.
  assert.equal(dayCheck(historyWith(weeks, today(12)), MON14, UTC).kind, "heavy");
  for (const pts of [3, 6, 9]) assert.equal(dayCheck(historyWith(weeks, today(pts)), MON14, UTC).kind, "usual", `${pts} points`);
});

test("a quiet day and a usual day", () => {
  const busy = [workWeek(6), workWeek(6), workWeek(6)];
  assert.equal(dayCheck(historyWith(busy, today(0)), MON14, UTC).kind, "quiet");
  assert.equal(dayCheck(historyWith([workWeek(), workWeek()], today(4)), MON14, UTC).kind, "usual");
});

test("no day check with under 2 weeks, or on the day of the reset before it", () => {
  assert.equal(dayCheck(historyWith([workWeek()], today(12)), MON14, UTC), null);
  const h = historyWith([workWeek(), workWeek()], { ...today(12), reset: iso(NEXT) });
  assert.equal(dayCheck(h, NEXT - WEEK_MS + 2 * H, UTC), null); // Thursday 06:00, reset at 04:00
});

test("the spread of past weeks raises the bar for a heavy day", () => {
  const varied = [workWeek(1), workWeek(4), workWeek(8)];
  // Usual by now 1.5, 6 and 12: spread 4.5. Band top 8, so a day needs 8 + 13.5 to count as heavy.
  assert.equal(dayCheck(historyWith(varied, today(20)), MON14, UTC).kind, "usual");
  assert.equal(dayCheck(historyWith(varied, today(22)), MON14, UTC).kind, "heavy");
});

test("the Budget line names a heavy day and uses the readings pattern", () => {
  const h = historyWith([workWeek(), workWeek(), workWeek()], today(12));
  const limits = { version: 1, fetched_at: iso(MON14), five_hour: { used: 10, resets_at: iso(MON14 + 2 * H) }, seven_day: { used: 55, resets_at: iso(NEXT) }, fable: { used: 10, resets_at: iso(NEXT) }, last_error: null };
  const b = buildBudget(limits, resolveConfig(null), MON14 + 60_000, h);
  assert.equal(b.pace_source, "readings");
  assert.match(b.line, /Heavy day: 12 points of the week used today, usually 3 by now\./);
  // 55 % by Monday afternoon is about on pace; the heavy day tips it over.
  assert.equal(b.seven_day.mode, "tight");
  assert.match(b.line, /week 55% tight \(on pace for \d+%/);
  const usual = buildBudget(limits, resolveConfig(null), MON14 + 60_000, historyWith([workWeek(), workWeek(), workWeek()], today(3)));
  assert.equal(usual.day.kind, "usual");
  assert.equal(usual.seven_day.mode, "steady");
  const plain = buildBudget(limits, resolveConfig(null), MON14 + 60_000, null);
  assert.equal(plain.pace_source, "straight line");
  assert.doesNotMatch(plain.line, /Heavy day/);
  const off = buildBudget(limits, resolveConfig({ pace: "off" }), MON14 + 60_000, h);
  assert.equal(off.day, null);
  assert.equal(off.pace_source, "off");
});

// ---------- transcripts ----------

test("a transcript line gives only a time and a weight, counted once per reply", () => {
  const seen = new Set();
  const line = JSON.stringify({ timestamp: iso(MON14), requestId: "r1", message: { id: "m1", content: [{ type: "text", text: "secret" }], usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000 } } });
  assert.deepEqual(eventFromLine(line, 0, seen), { at: MON14, weight: 100 + 50 + 100 });
  assert.equal(eventFromLine(line, 0, seen), null);
  assert.equal(eventFromLine('{"type":"user","message":{"content":"hi"}}', 0, seen), null);
  assert.equal(eventFromLine("not json \"usage\"", 0, seen), null);
  assert.equal(eventFromLine(line.replace("m1", "m2"), MON14 + 1, seen), null); // too old
});

test("the scan reads recent .jsonl files, including subagent folders, and keeps only shares", async () => {
  const root = mkdtempSync(join(tmpdir(), "mb-tr-"));
  const now = Date.now();
  const proj = join(root, "-Users-x-proj");
  mkdirSync(join(proj, "sess", "subagents"), { recursive: true });
  const ev = (id, at) => JSON.stringify({ timestamp: iso(at), message: { id, usage: { input_tokens: 10, output_tokens: 2 } } });
  writeFileSync(join(proj, "a.jsonl"), `${ev("a", now - D)}\n${ev("b", now - 2 * D)}\nbroken\n`);
  writeFileSync(join(proj, "sess", "subagents", "s.jsonl"), `${ev("c", now - D)}\n`);
  writeFileSync(join(proj, "old.jsonl"), `${ev("d", now - 60 * D)}\n`);
  utimesSync(join(proj, "old.jsonl"), new Date(now - 60 * D), new Date(now - 60 * D));
  writeFileSync(join(proj, "notes.txt"), ev("e", now));
  assert.equal(transcriptFiles(root, now - 35 * D).length, 2);
  const r = await scanTranscripts({ root, nowMs: now });
  assert.equal(r.events, 3);
  assert.equal(r.shares.length, BLOCKS);
  assert.ok(Math.abs(r.shares.reduce((s, x) => s + x, 0) - 1) < 1e-3);
  assert.deepEqual(await scanTranscripts({ root: join(root, "missing"), nowMs: now }), { shares: null, files: 0, read: 0, events: 0 });
});

test("sharesFromEvents sums weights per block", () => {
  const s = sharesFromEvents([{ at: MON14, weight: 3 }, { at: MON14 + H, weight: 1 }], UTC);
  assert.equal(s[blockIndex(MON14, UTC)], 1);
  assert.equal(sharesFromEvents([]), null);
});

// ---------- refresh writes the history ----------

const tmp = () => mkdtempSync(join(tmpdir(), "mb-hist-"));
const fakeFetch = (used, at) => async () => ({ ok: true, file: { version: 1, fetched_at: iso(at), fable_fetched_at: iso(at), five_hour: { used: 5, resets_at: iso(at + 2 * H) }, seven_day: { used, resets_at: iso(NEXT) }, fable: null, last_error: null } });

test("refresh records each good reading in history.json, compact and private", async () => {
  const dir = tmp();
  let t = MON14;
  await refresh(dir, { force: true, now: () => t, fetch: fakeFetch(20, t) });
  t += H;
  await refresh(dir, { force: true, now: () => t, fetch: fakeFetch(23, t) });
  const h = loadHistory(dir);
  assert.equal(h.last.used, 23);
  assert.equal(h.current.v.reduce((s, x) => s + x, 0), 3);
  const text = readFileSync(join(dir, "history.json"), "utf8");
  assert.equal(text.split("\n").length, 2, "one line of JSON");
  assert.equal(statSync(join(dir, "history.json")).mode & 0o777, 0o600);
});

test("a failed check records nothing", async () => {
  const dir = tmp();
  await refresh(dir, { force: true, now: () => MON14, fetch: async () => ({ ok: false, file: { version: 1, fetched_at: null, five_hour: null, seven_day: null, fable: null, last_error: { at: iso(MON14), message: "x" } } }) });
  assert.equal(readdirSync(dir).includes("history.json"), false);
});

test("the transcript scan runs only in the background, only when on, at most once a day", async () => {
  const dir = tmp();
  let scans = 0;
  const scanner = async () => {
    scans++;
    return { shares: workWeek(1 / 45).v };
  };
  let t = MON14;
  const go = (scan) => refresh(dir, { force: true, now: () => t, fetch: fakeFetch(20, t), scan, scanner });
  await go(true);
  assert.equal(scans, 0, "off by default");
  writeAtomic(join(dir, "config.json"), { transcripts: "on" });
  await go(false);
  assert.equal(scans, 0, "not in a foreground check");
  t += H;
  await go(true);
  assert.equal(scans, 1);
  t += H;
  await go(true);
  assert.equal(scans, 1, "once a day");
  assert.ok(loadHistory(dir).transcripts.shares);
  writeAtomic(join(dir, "config.json"), { transcripts: "off" });
  t += H;
  await go(true);
  assert.equal(loadHistory(dir).transcripts, null, "turning it off drops the stored pattern");
});

test("a scan that finds nothing still waits a day before the next one", async () => {
  const dir = tmp();
  writeAtomic(join(dir, "config.json"), { transcripts: "on" });
  let scans = 0;
  let t = MON14;
  const go = () => refresh(dir, { force: true, now: () => t, fetch: fakeFetch(20, t), scan: true, scanner: async () => (scans++, { shares: null }) });
  await go();
  t += H;
  await go();
  assert.equal(scans, 1);
  assert.equal(loadHistory(dir).transcripts.shares, null);
});

test("a scan that throws does not fail the refresh", async () => {
  const dir = tmp();
  writeAtomic(join(dir, "config.json"), { transcripts: "on" });
  const r = await refresh(dir, { force: true, now: () => MON14, fetch: fakeFetch(20, MON14), scan: true, scanner: async () => { throw new Error("boom"); } });
  assert.equal(r.ok, true);
});

test("the job copies every script module", () => {
  const dir = fileURLToPath(new URL("../skills/agent-budget/scripts/", import.meta.url));
  const mjs = readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
  assert.deepEqual([...SCRIPT_FILES].sort(), mjs);
});

// ---------- CLI ----------

import { spawnSync } from "node:child_process";
const SCRIPT = fileURLToPath(new URL("../skills/agent-budget/scripts/budget.mjs", import.meta.url));
const cli = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, MODEL_BUDGET_DIR: dir, MODEL_BUDGET_CLAUDE: "/nonexistent/claude" } });

test("CLI: transcripts setting, and show explains the pace source", () => {
  const dir = tmp();
  let r = cli(dir, "show");
  assert.match(r.stdout, /Weekly and Fable pace follow a straight line/);
  assert.match(r.stdout, /Transcript scan: off \(turn on with config set transcripts=on\)/);
  r = cli(dir, "config", "set", "transcripts=on");
  assert.equal(r.status, 0, r.stderr);
  assert.match(cli(dir, "show").stdout, /Transcript scan: on \(no scan yet/);
  assert.equal(cli(dir, "config", "set", "transcripts=maybe").status, 1);
});

// Never run a real `uninstall --yes` here: it would remove a real launchd job or cron line.
test("uninstall removes history.json with the other own files", () => {
  assert.ok(OWN_FILES.includes("history.json"));
});

// ---------- review fixes ----------

import { VERSION } from "../skills/agent-budget/scripts/core.mjs";
import { copyScripts, cronLineFor, plistFor, syncJobScripts } from "../skills/agent-budget/scripts/job.mjs";

test("when the pattern has no answer yet, the straight line keeps its 130 % bar", () => {
  // A pattern with all its weight just before the reset: 30 hours into the week, under 10 % of a
  // usual week has gone, so the pattern has no answer and the straight line takes over.
  const late = workWeek(0);
  late.v[4 * 6 + 0] = 10; // Thursday 00:00 to 04:00
  const h = historyWith([late, late]);
  const at = RESET + 30 * H;
  const l = { version: 1, fetched_at: iso(at), five_hour: null, seven_day: { used: 21, resets_at: iso(NEXT) }, fable: null, last_error: null };
  const b = buildBudget(l, resolveConfig(null), at + 60_000, h);
  assert.equal(b.seven_day.pace_from, "line");
  assert.equal(b.seven_day.pace, 118); // 21 / (30/168)
  assert.equal(b.seven_day.mode, "open"); // 118 is under the straight line's 130 bar (110 would have tightened)
});

test("a loosening step from steady to open that changes nothing is undone too", () => {
  const NOWX = Date.parse("2026-11-20T12:00:00Z");
  const l = { version: 1, fetched_at: iso(NOWX), five_hour: { used: 52, resets_at: iso(NOWX + 30 * 60_000) }, seven_day: { used: 52, resets_at: iso(NOWX + 1 * D) }, fable: null, last_error: null };
  const b = buildBudget(l, resolveConfig(null), NOWX);
  assert.equal(b.seven_day.mode, "steady");
  assert.equal(b.five_hour.mode, "steady");
  assert.doesNotMatch(b.line, /on pace/);
});

test("VERSION matches the plugin manifest", () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../.claude-plugin/plugin.json", import.meta.url)), "utf8"));
  assert.equal(VERSION, manifest.version);
});

test("a stale job copy is refreshed, a current one is left alone, and no job means nothing", () => {
  const src = fileURLToPath(new URL("../skills/agent-budget/scripts/", import.meta.url));
  const dir = tmp();
  assert.equal(syncJobScripts(dir, src), false);
  copyScripts(dir, src);
  assert.equal(syncJobScripts(dir, src), false);
  writeFileSync(join(dir, "bin", "VERSION"), "1.1.0\n");
  assert.equal(syncJobScripts(dir, src), true);
  assert.equal(readFileSync(join(dir, "bin", "VERSION"), "utf8").trim(), VERSION);
  // A 1.1.0 copy had no VERSION file and no history.mjs.
  const old = tmp();
  mkdirSync(join(old, "bin"));
  writeFileSync(join(old, "bin", "budget.mjs"), "// old");
  assert.equal(syncJobScripts(old, src), true);
  assert.ok(readdirSync(join(old, "bin")).includes("history.mjs"));
});

test("the job passes CLAUDE_CONFIG_DIR on when it is set", () => {
  const o = { node: "/n/node", script: "/d/bin/budget.mjs", claude: "/c/claude", dir: "/d" };
  assert.doesNotMatch(plistFor(o), /CLAUDE_CONFIG_DIR/);
  assert.match(plistFor({ ...o, configDir: "/x/.claude" }), /<key>CLAUDE_CONFIG_DIR<\/key><string>\/x\/\.claude<\/string>/);
  assert.match(cronLineFor({ ...o, configDir: "/x/.claude" }), / CLAUDE_CONFIG_DIR='\/x\/\.claude' /);
});
