import { test } from "node:test";
import assert from "node:assert/strict";
import { safeEnv, tempDir } from "./safe-env.mjs";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applySettings, hook, refresh, writeAtomic } from "../skills/agent-budget/scripts/budget.mjs";
import { askClaude, childEnv, fetchLimits } from "../skills/agent-budget/scripts/fetch.mjs";
import { cronLineFor, editCrontab, plistFor, stableNode, CRON_MARKER } from "../skills/agent-budget/scripts/job.mjs";

const SCRIPT = fileURLToPath(new URL("../skills/agent-budget/scripts/budget.mjs", import.meta.url));
const tmp = () => tempDir("model-budget-test-");
const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.now();
const win = (used) => ({ used, resets_at: iso(NOW + 3 * 3600_000) });
const freshLimits = (ageMin = 1) => ({ version: 1, fetched_at: iso(NOW - ageMin * 60_000), five_hour: win(20), seven_day: win(10), fable: win(10), last_error: null });

const cli = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: safeEnv(dir) });

test("hook prints the line for a fresh reading and does not refresh", () => {
  const dir = tmp();
  writeAtomic(join(dir, "limits.json"), freshLimits());
  let spawned = 0;
  const line = hook(dir, { spawnRefresh: () => spawned++ });
  assert.match(line, /^Budget: 5h 20% open/);
  assert.equal(spawned, 0);
});

test("hook prints the fallback and starts a refresh when there is no reading", () => {
  const dir = tmp();
  let spawned = 0;
  assert.match(hook(dir, { spawnRefresh: () => spawned++ }), /^Budget: no usage reading yet\. Fallback:/);
  assert.equal(spawned, 1);
});

test("hook refreshes in the background when the reading is over 15 minutes old", () => {
  const dir = tmp();
  writeAtomic(join(dir, "limits.json"), freshLimits(20));
  let spawned = 0;
  assert.match(hook(dir, { spawnRefresh: () => spawned++ }), /^Budget: 5h 20% open/);
  assert.equal(spawned, 1);
});

test("hook does not refresh while another refresh holds the lock", () => {
  const dir = tmp();
  writeFileSync(join(dir, "refresh.lock"), "1\n");
  let spawned = 0;
  hook(dir, { spawnRefresh: () => spawned++ });
  assert.equal(spawned, 0);
});

test("hook ignores an oversized or broken limits file", () => {
  const dir = tmp();
  writeFileSync(join(dir, "limits.json"), "x".repeat(20_000));
  assert.match(hook(dir, { spawnRefresh: () => {} }), /^Budget: no usage reading yet/);
  writeFileSync(join(dir, "limits.json"), "{not json");
  assert.match(hook(dir, { spawnRefresh: () => {} }), /^Budget: no usage reading yet/);
});

test("hook command always exits 0 and prints one line", () => {
  const dir = tmp();
  writeFileSync(join(dir, "config.json"), "{broken");
  writeAtomic(join(dir, "limits.json"), freshLimits());
  const r = cli(dir, "hook");
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim().split("\n").length, 1);
  assert.match(r.stdout, /Settings have 1 problem/);
});

test("refresh writes limits.json and budget.json with mode 0600", async () => {
  const dir = tmp();
  const fake = async (prev) => ({ ok: true, file: freshLimits(0) });
  const r = await refresh(dir, { fetch: fake });
  assert.equal(r.ran, true);
  for (const f of ["limits.json", "budget.json"]) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(dir, "budget.json"), "utf8")).status, "fresh");
  assert.equal(existsSync(join(dir, "refresh.lock")), false);
});

test("refresh skips a fresh reading unless forced", async () => {
  const dir = tmp();
  writeAtomic(join(dir, "limits.json"), freshLimits(2));
  let calls = 0;
  const fake = async () => (calls++, { ok: true, file: freshLimits(0) });
  assert.equal((await refresh(dir, { fetch: fake })).ran, false);
  assert.equal((await refresh(dir, { fetch: fake, force: true })).ran, true);
  assert.equal(calls, 1);
});

test("a failed check keeps the last windows and records the error", async () => {
  const prev = freshLimits(60);
  const r = await fetchLimits(prev, { claude: "x", ask: async () => { throw new Error("boom"); } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.file.five_hour, prev.five_hour);
  assert.equal(r.file.last_error.message, "boom");
  const none = await fetchLimits(null, { claude: null });
  assert.match(none.file.last_error.message, /could not find the claude command/);
});

test("askClaude talks get_usage to a fake claude and drops everything else", async () => {
  const dir = tmp();
  const fake = join(dir, "claude");
  writeFileSync(fake, `#!/usr/bin/env node
process.stdin.once("data", (d) => {
  const req = JSON.parse(String(d));
  if (req.request.subtype !== "get_usage") process.exit(3);
  console.log("not json");
  console.log(JSON.stringify({ type: "system" }));
  console.log(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: req.request_id, response: { rate_limits: { five_hour: { utilization: 42, resets_at: "${iso(NOW + 3600_000)}" } } } } }));
  setInterval(() => {}, 1000);
});
`);
  chmodSync(fake, 0o755);
  const rl = await askClaude(fake, { timeoutMs: 5000 });
  assert.equal(rl.five_hour.utilization, 42);
});

test("askClaude times out and reports a missing binary", async () => {
  const dir = tmp();
  const slow = join(dir, "claude");
  writeFileSync(slow, "#!/bin/sh\nsleep 10\n");
  chmodSync(slow, 0o755);
  await assert.rejects(askClaude(slow, { timeoutMs: 300 }), /did not answer within/);
  await assert.rejects(askClaude(join(dir, "missing"), { timeoutMs: 300 }), /could not find the claude command at/);
});

test("child env drops API key and nested-session variables and turns telemetry off", () => {
  const env = childEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "k", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CONFIG_DIR: "/c" });
  assert.deepEqual(env, { PATH: "/bin", CLAUDE_CONFIG_DIR: "/c", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1" });
  assert.equal(childEnv({ CLAUDE_CODE_OAUTH_TOKEN: "t" }).CLAUDE_CODE_OAUTH_TOKEN, "t");
});

test("config set merges settings, validates, and * sets every mode", () => {
  const raw = applySettings({ roles: { open: { plan: "opus" } } }, ["thresholds.tight=80", "all.mechanical=haiku", "delegate=always", "roles.tight.final_check=none"]);
  assert.equal(raw.roles.open.plan, "opus");
  assert.equal(raw.roles.open.mechanical, "haiku");
  assert.equal(raw.roles.exhausted.mechanical, "haiku");
  assert.equal(raw.roles.tight.final_check, "none");
  assert.equal(raw.thresholds.tight, 80);
  assert.equal(raw.delegate, "always");
  assert.throws(() => applySettings({}, ["open.plan=gpt"]), /model must be/);
  assert.throws(() => applySettings({}, ["thresholds.tight=95"]), /must rise/);
  assert.throws(() => applySettings({}, ["colour=blue"]), /unknown setting/);
});

test("CLI config set, show and reset round trip", () => {
  const dir = tmp();
  writeAtomic(join(dir, "limits.json"), freshLimits());
  let r = cli(dir, "config", "set", "open.plan=sonnet");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Plan sonnet/);
  assert.equal(statSync(join(dir, "config.json")).mode & 0o777, 0o600);
  r = cli(dir, "config", "set", "open.plan=gpt");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /model must be/);
  r = cli(dir, "show");
  assert.match(r.stdout, /open\s+sonnet/);
  r = cli(dir, "config", "reset");
  assert.match(r.stdout, /Plan fable/);
});

test("check with no claude prints the fallback and the failure", () => {
  const dir = tmp();
  const r = cli(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no usage reading yet; last check failed: could not find the claude command/);
});

test("uninstall needs --yes", () => {
  const dir = tmp();
  writeAtomic(join(dir, "config.json"), {});
  assert.equal(cli(dir, "uninstall").status, 1);
  assert.equal(existsSync(join(dir, "config.json")), true);
});

test("plist and cron line use absolute paths and the marker", () => {
  const o = { node: "/opt/homebrew/bin/node", script: "/h/.config/model-budget/bin/budget.mjs", claude: "/h/.local/bin/claude", dir: "/h/.config/model-budget" };
  const p = plistFor(o);
  assert.match(p, /<string>local\.model-budget\.refresh<\/string>/);
  assert.match(p, /<integer>900<\/integer>/);
  assert.match(p, /<string>\/opt\/homebrew\/bin\/node<\/string><string>\/h\/\.config\/model-budget\/bin\/budget\.mjs<\/string><string>refresh<\/string><string>--force<\/string>/);
  const c = cronLineFor({ ...o, dir: "/h/it's" });
  assert.ok(c.startsWith("*/15 * * * * PATH='/opt/homebrew/bin:/h/.local/bin:/usr/local/bin:/usr/bin:/bin' "));
  assert.match(c, / refresh --force --quiet /);
  assert.ok(c.endsWith(CRON_MARKER));
  assert.match(c, /'\/h\/it'\\''s'/);
});

test("editCrontab only touches model-budget lines", () => {
  const cur = `0 1 * * * backup\n*/15 * * * * old ${CRON_MARKER}\n`;
  assert.equal(editCrontab(cur, `new ${CRON_MARKER}`), `0 1 * * * backup\nnew ${CRON_MARKER}\n`);
  assert.equal(editCrontab(cur, null), "0 1 * * * backup\n");
  assert.equal(editCrontab("", null), "");
});

test("config set writes every value out, keeping earlier changes", () => {
  const dir = tmp();
  assert.equal(cli(dir, "config", "set", "open.plan=opus").status, 0);
  assert.equal(cli(dir, "config", "set", "thresholds.tight=80").status, 0);
  const f = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.ok(Array.isArray(f._help));
  assert.deepEqual(Object.keys(f.roles), ["open", "steady", "tight", "out", "exhausted"]);
  assert.deepEqual(Object.keys(f.roles.out), ["plan", "build", "review", "final_check", "mechanical"]);
  assert.equal(f.roles.open.plan, "opus");
  assert.equal(f.roles.open.review, "fable");
  assert.deepEqual(f.thresholds, { steady: 50, tight: 80, out: 90 });
  assert.equal(f.delegate, "bigger");
});

test("a hand-edited full file is read back, and _help is not a problem", () => {
  const dir = tmp();
  assert.equal(cli(dir, "config", "init").status, 0);
  const f = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  f.roles.steady.review = "opus";
  writeFileSync(join(dir, "config.json"), JSON.stringify(f, null, 2));
  const r = JSON.parse(cli(dir, "config").stdout);
  assert.equal(r.roles.steady.review, "opus");
  assert.deepEqual(r.problems, []);
});

test("config init refuses to overwrite a broken file", () => {
  const dir = tmp();
  writeFileSync(join(dir, "config.json"), "{broken");
  const r = cli(dir, "config", "init");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fix them first/);
  assert.equal(readFileSync(join(dir, "config.json"), "utf8"), "{broken");
});

test("config reset writes the full defaults", () => {
  const dir = tmp();
  cli(dir, "config", "set", "open.plan=haiku");
  assert.equal(cli(dir, "config", "reset").status, 0);
  const f = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(f.roles.open.plan, "fable");
  assert.equal(f.roles.exhausted.mechanical, "haiku");
});

test("editCrontab keeps the user's blank lines and comments", () => {
  const cur = `# mine\n\n0 1 * * * backup\n\n*/15 * * * * old ${CRON_MARKER}\n`;
  assert.equal(editCrontab(cur, null), "# mine\n\n0 1 * * * backup\n\n");
});

test("uninstall deletes only model-budget files, never other files in the folder", () => {
  const dir = tmp();
  writeAtomic(join(dir, "config.json"), {});
  writeAtomic(join(dir, "limits.json"), freshLimits());
  writeFileSync(join(dir, "someone-else.txt"), "keep me");
  const r = cli(dir, "uninstall", "--yes");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(dir, "config.json")), false);
  assert.equal(existsSync(join(dir, "limits.json")), false);
  assert.equal(readFileSync(join(dir, "someone-else.txt"), "utf8"), "keep me");
});

test("uninstall removes the folder when it is left empty", () => {
  const dir = tmp();
  writeAtomic(join(dir, "config.json"), {});
  assert.equal(cli(dir, "uninstall", "--yes").status, 0);
  assert.equal(existsSync(dir), false);
});

test("config set refuses to overwrite a broken file", () => {
  const dir = tmp();
  writeFileSync(join(dir, "config.json"), '{"roles": {},}');
  const r = cli(dir, "config", "set", "open.plan=opus");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fix them first/);
  assert.equal(readFileSync(join(dir, "config.json"), "utf8"), '{"roles": {},}');
});

test("check still prints a line when the folder cannot be created", () => {
  const base = tmp();
  writeFileSync(join(base, "file"), "x");
  const r = cli(join(base, "file", "sub"));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Budget: .*Could not update the reading/);
});

test("a stale lock taken over by another run is not removed by the first", async () => {
  const dir = tmp();
  let release;
  const slow = (prev) => new Promise((res) => { release = () => res({ ok: true, file: freshLimits(0) }); });
  const p = refresh(dir, { fetch: slow });
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(dir, "refresh.lock"), "someone else\n");
  release();
  await p;
  assert.equal(readFileSync(join(dir, "refresh.lock"), "utf8"), "someone else\n");
});

test("stableNode prefers a PATH link to the same node", () => {
  const dir = tmp();
  const real = join(dir, "Cellar", "node", "1.0", "bin");
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, "node"), "");
  const linkDir = join(dir, "bin");
  mkdirSync(linkDir);
  symlinkSync(join(real, "node"), join(linkDir, "node"));
  assert.equal(stableNode(join(real, "node"), `/nonexistent:${linkDir}`), join(linkDir, "node"));
  assert.equal(stableNode(join(real, "node"), "/nonexistent"), join(real, "node"));
});

test("a carried Fable window keeps its own age; a new one is stamped now", async () => {
  const prev = { ...freshLimits(60), fable_fetched_at: iso(NOW - 90 * 60_000) };
  const resets = iso(NOW + 3600_000);
  const carried = await fetchLimits(prev, { claude: "x", ask: async () => ({ five_hour: { utilization: 5, resets_at: resets } }) });
  assert.equal(carried.file.fable_fetched_at, prev.fable_fetched_at);
  const fresh = await fetchLimits(prev, { claude: "x", now: () => NOW, ask: async () => ({ model_scoped: [{ display_name: "Fable", utilization: 3, resets_at: resets }] }) });
  assert.equal(fresh.file.fable_fetched_at, iso(NOW));
});
