// model-budget: the usage fetch. The only network use in this project, and Claude Code makes it.
//
// It starts Claude Code headless and sends one `get_usage` control request: the same data `/usage`
// shows. No prompt is sent and no tokens are used. Claude Code calls Anthropic with its own login, so
// this script never sees or handles a token. Only the three limit windows are kept. The rest of the
// answer is dropped and never logged.

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { holdDrops, windowsFromUsage } from "./core.mjs";

export const TIMEOUT_MS = 30_000;
const REQUEST_ID = "model-budget-usage";

const isExec = (p) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** MODEL_BUDGET_CLAUDE, then PATH, then the usual install places. null when not found. */
export function findClaude(env = process.env, home = homedir()) {
  if (env.MODEL_BUDGET_CLAUDE) return env.MODEL_BUDGET_CLAUDE;
  for (const dir of (env.PATH ?? "").split(delimiter)) if (dir && isExec(join(dir, "claude"))) return join(dir, "claude");
  const guesses = [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude"];
  return guesses.find(isExec) ?? null;
}

/**
 * Environment for the child Claude Code:
 * - no ANTHROPIC_API_KEY (an API key hides the plan limits);
 * - no CLAUDECODE / CLAUDE_CODE_* (so it does not think it is nested inside the calling session),
 *   except CLAUDE_CODE_OAUTH_TOKEN, which some users log in with;
 * - telemetry, error reporting and the auto-updater off.
 */
export function childEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k === "ANTHROPIC_API_KEY" || k === "CLAUDECODE" || (k.startsWith("CLAUDE_CODE_") && k !== "CLAUDE_CODE_OAUTH_TOKEN")) continue;
    out[k] = v;
  }
  out.DISABLE_TELEMETRY = "1";
  out.DISABLE_ERROR_REPORTING = "1";
  out.DISABLE_AUTOUPDATER = "1";
  return out;
}

export const CLAUDE_ARGS = [
  "-p",
  "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  // No settings, hooks, plugins or MCP servers load (so this plugin's own hook does not run again),
  // and no transcript is saved. (--bare cannot be used: it skips the subscription login.)
  "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence",
];

/** `response.rate_limits` from Claude Code's answer to get_usage. Throws with a short reason. */
export function askClaude(claude, { timeoutMs = TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let buf = "";
    const child = spawn(claude, CLAUDE_ARGS, { cwd: tmpdir(), env: childEnv(env), stdio: ["pipe", "pipe", "ignore"] });
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`Claude Code did not answer within ${timeoutMs / 1000} s`)), timeoutMs);
    child.on("error", (e) => finish(new Error(e.code === "ENOENT" ? `could not find the claude command at ${claude} (set MODEL_BUDGET_CLAUDE to its full path)` : `could not start Claude Code: ${e.code ?? e.message}`)));
    child.on("close", (code) => finish(new Error(`Claude Code exited without an answer (code ${code})`)));
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg?.type !== "control_response" || msg.response?.request_id !== REQUEST_ID) continue;
        if (msg.response.subtype !== "success") return finish(new Error(`Claude Code refused get_usage: ${String(msg.response.error ?? "unknown error").slice(0, 120)}`));
        const r = msg.response.response;
        if (r?.rate_limits_available === false) return finish(new Error("no plan limits for this login (API key or no subscription)"));
        return finish(null, r?.rate_limits);
      }
    });
    child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "get_usage" } })}\n`);
  });
}

/** One check. Returns the new limits file content; on failure keeps the last windows and sets last_error. */
export async function fetchLimits(prev, { claude, now = () => Date.now(), ask = askClaude } = {}) {
  const empty = { version: 1, fetched_at: null, five_hour: null, seven_day: null, fable: null, last_error: null };
  try {
    if (!claude) throw new Error("could not find the claude command (set MODEL_BUDGET_CLAUDE to its full path)");
    const windows = windowsFromUsage(await ask(claude), prev);
    if (!windows) throw new Error("Claude Code answered without any plan limits");
    const at = new Date(now()).toISOString();
    // When the Fable window was carried over from the previous answer, keep its own age.
    const carried = windows.fable !== null && windows.fable === prev?.fable;
    const fable_fetched_at = windows.fable === null ? null : carried ? prev.fable_fetched_at ?? prev.fetched_at : at;
    // A big drop waits for the next reading (holdDrops). Which windows pace moved tighter carries over.
    const file = holdDrops(prev, { version: 1, fetched_at: at, fable_fetched_at, ...windows, last_error: null }, now());
    if (prev?.paced) file.paced = prev.paced;
    return { ok: true, file };
  } catch (e) {
    // Count failures in a row, so a lasting problem is reported even when prompts are far apart.
    const count = (prev?.last_error && !(Date.parse(prev.last_error.at) < Date.parse(prev.fetched_at ?? 0)) ? prev.last_error.count ?? 1 : 0) + 1;
    return { ok: false, file: { ...(prev ?? empty), last_error: { at: new Date(now()).toISOString(), message: String(e.message).slice(0, 300), count } } };
  }
}
