// Tests for the fixes from the third review: real drops, half-seen blocks, the job copy, the lock,
// the scan timeout, show without a fresh reading, and the job install and removal with a fake crontab.
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeEnv, tempDir } from "./safe-env.mjs";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCKS, WEEK_MS, dayCheck, emptyHistory, patternPace, patternShares, recordReading } from "../skills/agent-budget/scripts/history.mjs";
import { VERSION, buildBudget, paceFor, resolveConfig } from "../skills/agent-budget/scripts/core.mjs";
import { hook, refresh, writeAtomic } from "../skills/agent-budget/scripts/budget.mjs";
import { CRON_MARKER, compareVersions, copyScripts, installJob, syncJobScripts, uninstallJob } from "../skills/agent-budget/scripts/job.mjs";
import { scanTranscripts } from "../skills/agent-budget/scripts/transcripts.mjs";

process.env.TZ = "UTC";
const UTC = () => 0;
const H = 3_600_000;
const D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
const tmp = () => tempDir("mb-r3-");
const RESET = Date.parse("2026-11-19T04:00:00Z");
const NEXT = RESET + WEEK_MS;
const SRC = fileURLToPath(new URL("../skills/agent-budget/scripts/", import.meta.url));
const SCRIPT = join(SRC, "budget.mjs");
const sum = (a) => a.reduce((s, x) => s + x, 0);

function workWeek(perBlock = 2) {
  const v = new Array(BLOCKS).fill(0);
  for (let day = 1; day <= 5; day++) for (const b of [2, 3, 4]) v[day * 6 + b] = perBlock;
  return { v, c: new Array(BLOCKS).fill(1) };
}

// ---------- history ----------

test("a real drop restarts the count, so later use is still recorded", () => {
  let h = recordReading(null, { at: iso(RESET + D), used: 60, resets_at: iso(NEXT) }, UTC);
  h = recordReading(h, { at: iso(RESET + D + H), used: 0, resets_at: iso(NEXT + 2 * H) }, UTC);
  h = recordReading(h, { at: iso(RESET + D + 2 * H), used: 40, resets_at: iso(NEXT + 2 * H) }, UTC);
  assert.equal(sum(h.current.v), 40);
});

test("a wobble of 2 points still keeps the high", () => {
  let h = recordReading(null, { at: iso(RESET + D), used: 30, resets_at: iso(NEXT) }, UTC);
  h = recordReading(h, { at: iso(RESET + D + H), used: 28, resets_at: iso(NEXT) }, UTC);
  h = recordReading(h, { at: iso(RESET + D + 2 * H), used: 30, resets_at: iso(NEXT) }, UTC);
  assert.equal(sum(h.current.v), 0);
});

test("the day check leaves out blocks that are only half seen", () => {
  // Last night's 10 points spread over the gap land partly in this morning's block, half seen.
  const cur = { reset: iso(NEXT), v: new Array(BLOCKS).fill(0), c: new Array(BLOCKS).fill(1) };
  const mon = 1 * 6;
  cur.v[mon + 0] = 5; // Monday 00:00 to 04:00, from an overnight gap
  cur.c[mon + 0] = 0.5;
  cur.v[mon + 1] = 5;
  cur.c[mon + 1] = 0.5;
  cur.v[mon + 2] = 2; // 08:00 to 12:00, seen
  const h = { ...emptyHistory(), weeks: [workWeek(), workWeek(), workWeek()], current: cur };
  const d = dayCheck(h, Date.parse("2026-11-23T11:00:00Z"), UTC);
  assert.equal(d.actual, 2);
  assert.equal(d.kind, "usual");
});

test("the README example: Fable at 35 % on Friday evening", () => {
  const h = { ...emptyHistory(), weeks: [workWeek(), workWeek()] };
  const { shares } = patternShares(h);
  const fri20 = Date.parse("2026-11-20T20:00:00Z");
  const left = (RESET + WEEK_MS - fri20) / 60_000;
  assert.equal(paceFor(35, Math.round(left), 7 * 24 * 60), 147);
  assert.equal(patternPace(35, RESET + WEEK_MS, fri20, 7 * 24 * 60, shares, null, UTC), 93);
});

// ---------- core and show ----------

test("a Fable pace step between open and steady with equal rows is undone", () => {
  const NOW = Date.parse("2026-11-20T12:00:00Z");
  const l = { version: 1, fetched_at: iso(NOW), five_hour: null, seven_day: { used: 10, resets_at: iso(NOW + 5 * D) }, fable: { used: 45, resets_at: iso(NOW + 5 * D) }, last_error: null };
  const allOpus = resolveConfig({ roles: { open: { plan: "opus", review: "opus" }, steady: { plan: "opus", review: "opus" } }, effort: { open: { plan: "high" }, steady: { plan: "high" } } });
  const b = buildBudget(l, allOpus, NOW);
  assert.equal(b.fable.pace, 158);
  assert.equal(b.fable.mode, "open");
  assert.doesNotMatch(b.line, /on pace/);
});

const cli = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: safeEnv(dir) });

test("show without a fresh reading still says where pace comes from", () => {
  const dir = tmp();
  writeAtomic(join(dir, "config.json"), { pace: "off" });
  assert.match(cli(dir, "show").stdout, /Weekly and Fable pace follow nothing \(pace is off\)/);
  const dir2 = tmp();
  writeAtomic(join(dir2, "history.json"), { ...emptyHistory(), weeks: [workWeek(), workWeek()] }, { compact: true });
  assert.match(cli(dir2, "show").stdout, /Weekly and Fable pace follow your own rhythm \(2 full weeks/);
});

// ---------- the job copy ----------

test("versions compare as numbers", () => {
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("1.2.0", "1.3.0"), -1);
  assert.equal(compareVersions("junk", "0.0.1"), -1);
});

test("the job copy is only ever replaced by a newer version", () => {
  const dir = tmp();
  copyScripts(dir, SRC);
  writeFileSync(join(dir, "bin", "VERSION"), "9.9.9\n");
  assert.equal(syncJobScripts(dir, SRC), false);
  assert.equal(readFileSync(join(dir, "bin", "VERSION"), "utf8").trim(), "9.9.9");
});

test("the copied scripts are private and complete", () => {
  const dir = tmp();
  copyScripts(dir, SRC);
  for (const f of readdirSync(join(dir, "bin"))) assert.equal(statSync(join(dir, "bin", f)).mode & 0o777, 0o600, f);
  assert.equal(readdirSync(join(dir, "bin")).some((f) => f.endsWith(".tmp")), false);
});

test("the hook refreshes a stale job copy and still prints one line", () => {
  const dir = tmp();
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "budget.mjs"), "// a 1.1.0 copy");
  const line = hook(dir, { spawnRefresh: () => {} });
  assert.match(line, /^Budget: /);
  assert.equal(line.includes("\n"), false);
  assert.equal(readFileSync(join(dir, "bin", "VERSION"), "utf8").trim(), VERSION);
});

// ---------- lock and scan ----------

test("a stale lock left by a crashed run is taken over", async () => {
  const dir = tmp();
  const lock = join(dir, "refresh.lock");
  writeFileSync(lock, "999 0 dead\n");
  const old = new Date(Date.now() - 5 * 60_000);
  utimesSync(lock, old, old);
  const now = Date.now();
  const r = await refresh(dir, { force: true, fetch: async () => ({ ok: true, file: { version: 1, fetched_at: iso(now), five_hour: null, seven_day: { used: 5, resets_at: iso(now + D) }, fable: null, last_error: null } }) });
  assert.equal(r.ran, true);
  assert.equal(existsSync(lock), false);
});

test("the scan stops at its time limit", async () => {
  const root = tmp();
  const now = Date.now();
  for (let i = 0; i < 5; i++) writeFileSync(join(root, `${i}.jsonl`), `${JSON.stringify({ timestamp: iso(now - D), message: { id: `m${i}`, usage: { input_tokens: 1 } } })}\n`);
  const r = await scanTranscripts({ root, nowMs: now, timeoutMs: -1 });
  assert.equal(r.files, 5);
  assert.equal(r.read, 0);
});

// ---------- job install and removal, with a fake crontab (never the real one) ----------

function fakeCrontab() {
  const bin = tmp();
  const file = join(tmp(), "crontab.txt");
  const sh = join(bin, "crontab");
  writeFileSync(sh, `#!/bin/sh
F='${file}'
case "$1" in
  -l) if [ -f "$F" ]; then /bin/cat "$F"; else echo "no crontab for test" >&2; exit 1; fi ;;
  -r) /bin/rm -f "$F" ;;
  -) /bin/cat > "$F" ;;
esac
`);
  chmodSync(sh, 0o755);
  return { bin, file };
}

test("job on and off on Linux touch only the model-budget line", () => {
  const { bin, file } = fakeCrontab();
  writeFileSync(file, "0 1 * * * backup\n");
  const saved = process.env.PATH;
  process.env.PATH = bin;
  try {
    const dir = tmp();
    const msg = installJob({ dir, claude: "/x/claude", node: process.execPath, sourceDir: SRC, platform: "linux", home: tmp(), configDir: null });
    assert.match(msg, /cron job installed/);
    let tab = readFileSync(file, "utf8");
    assert.match(tab, /^0 1 \* \* \* backup\n/);
    assert.ok(tab.trimEnd().endsWith(CRON_MARKER));
    assert.ok(existsSync(join(dir, "bin", "VERSION")));
    installJob({ dir, claude: "/x/claude", node: process.execPath, sourceDir: SRC, platform: "linux", home: tmp(), configDir: null });
    tab = readFileSync(file, "utf8");
    assert.equal(tab.split("\n").filter((l) => l.endsWith(CRON_MARKER)).length, 1, "installing twice keeps one line");
    assert.match(uninstallJob({ dir, platform: "linux", home: tmp() }), /removed the cron line/);
    assert.equal(readFileSync(file, "utf8"), "0 1 * * * backup\n");
    assert.equal(existsSync(join(dir, "bin")), false);
  } finally {
    process.env.PATH = saved;
  }
});

// ---------- fourth review ----------

test("one odd low reading is held, not counted; two in a row restart the count", () => {
  let h = recordReading(null, { at: iso(RESET + D), used: 60, resets_at: iso(NEXT) }, UTC);
  for (const [i, used] of [60, 12, 60].entries()) h = recordReading(h, { at: iso(RESET + D + (i + 1) * H), used, resets_at: iso(NEXT) }, UTC);
  assert.equal(sum(h.current.v), 0, "60, 60, 12, 60 records nothing");
  let g = recordReading(null, { at: iso(RESET + D), used: 40, resets_at: iso(NEXT) }, UTC);
  for (const [i, used] of [45, 42, 46].entries()) g = recordReading(g, { at: iso(RESET + D + (i + 1) * H), used, resets_at: iso(NEXT) }, UTC);
  assert.equal(sum(g.current.v), 6, "40, 45, 42, 46 records 6");
});

test("a quiet day is seen even when the current block is only half seen", () => {
  const cur = { reset: iso(NEXT), v: new Array(BLOCKS).fill(0), c: new Array(BLOCKS).fill(1) };
  cur.c[1 * 6 + 3] = 0.5; // Monday 12:00 to 16:00, half seen
  const h = { ...emptyHistory(), weeks: [workWeek(4), workWeek(4), workWeek(4)], current: cur };
  // At 13:00 with nothing used, usual by 12:00 is 4: band 4 to 4, quiet below 4 - 3 = 1.
  assert.equal(dayCheck(h, Date.parse("2026-11-23T13:00:00Z"), UTC).kind, "quiet");
});

test("the CLI refuses extra arguments, so a pre-approved command carries nothing else", () => {
  const dir = tmp();
  for (const args of [["show", "config"], ["config", "reset", "show"], ["config", "show", "x"], ["uninstall", "--yes", "config"], ["refresh", "--now"], ["job", "status", "on"], ["config", "set", "pace=off", "reset"]]) {
    const r = cli(dir, ...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, /unexpected argument|only KEY=VALUE/, args.join(" "));
  }
  assert.equal(existsSync(join(dir, "config.json")), false);
  assert.equal(cli(dir, "show").status, 0);
});

test("a second copy while one is running skips, and leaves no temp files", () => {
  const dir = tmp();
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", ".copy.lock"), "");
  assert.equal(copyScripts(dir, SRC), null);
  assert.equal(readdirSync(join(dir, "bin")).filter((f) => f.endsWith(".tmp")).length, 0);
  const old = new Date(Date.now() - 5 * 60_000);
  utimesSync(join(dir, "bin", ".copy.lock"), old, old);
  assert.equal(copyScripts(dir, SRC), join(dir, "bin"));
  assert.equal(existsSync(join(dir, "bin", ".copy.lock")), false);
});
