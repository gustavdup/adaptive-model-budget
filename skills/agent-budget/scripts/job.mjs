// model-budget: the optional 15-minute background job. Off unless the user turns it on.
// macOS: a per-user launchd agent. Linux: one crontab line with a marker comment.
// The job runs a copy of the scripts in <config dir>/bin, because the plugin's own folder changes
// path on every plugin update.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { VERSION } from "./core.mjs";

export const LABEL = "local.model-budget.refresh";
export const CRON_MARKER = "# model-budget";
export const SCRIPT_FILES = ["core.mjs", "history.mjs", "fetch.mjs", "transcripts.mjs", "job.mjs", "budget.mjs"];

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Single-quote for sh, safe for any path. */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export const plistPath = (home = homedir()) => join(home, "Library", "LaunchAgents", `${LABEL}.plist`);

/** The launchd plist. Absolute paths everywhere: launchd's PATH has no Homebrew. */
export function plistFor({ node, script, claude, dir, configDir = null }) {
  const str = (s) => `<string>${xml(s)}</string>`;
  const path = [...new Set([dirname(node), dirname(claude), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(LABEL)}
  <key>ProgramArguments</key>
  <array>${str(node)}${str(script)}${str("refresh")}${str("--force")}${str("--quiet")}</array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MODEL_BUDGET_CLAUDE</key>${str(claude)}
    <key>MODEL_BUDGET_DIR</key>${str(dir)}${configDir ? `
    <key>CLAUDE_CONFIG_DIR</key>${str(configDir)}` : ""}
    <key>PATH</key>${str(path)}
  </dict>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key>${str("Background")}
  <key>StandardOutPath</key>${str(join(dir, "run.log"))}
  <key>StandardErrorPath</key>${str(join(dir, "run.log"))}
</dict>
</plist>
`;
}

/** The crontab line: every 15 minutes, ending in the marker so uninstall removes only this line. */
export function cronLineFor({ node, script, claude, dir, configDir = null }) {
  const path = [...new Set([dirname(node), dirname(claude), "/usr/local/bin", "/usr/bin", "/bin"])].join(":");
  const cfg = configDir ? ` CLAUDE_CONFIG_DIR=${shq(configDir)}` : "";
  return `*/15 * * * * PATH=${shq(path)} MODEL_BUDGET_CLAUDE=${shq(claude)} MODEL_BUDGET_DIR=${shq(dir)}${cfg} ${shq(node)} ${shq(script)} refresh --force --quiet >> ${shq(join(dir, "run.log"))} 2>&1 ${CRON_MARKER}`;
}

/**
 * The node path to bake into the job. Prefer a PATH entry (like /opt/homebrew/bin/node) that points
 * at the running node, because the real path (a versioned Cellar folder) breaks on upgrade.
 */
export function stableNode(execPath = process.execPath, envPath = process.env.PATH ?? "") {
  let real;
  try {
    real = realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const dir of envPath.split(delimiter)) {
    if (!dir) continue;
    const cand = join(dir, "node");
    try {
      if (realpathSync(cand) === real) return cand;
    } catch {}
  }
  return execPath;
}

/** The crontab with every model-budget line removed, then `add` appended when given. */
export function editCrontab(current, add) {
  const lines = current.split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  const kept = lines.filter((l) => !l.trimEnd().endsWith(CRON_MARKER));
  if (add) kept.push(add);
  return kept.length ? `${kept.join("\n")}\n` : "";
}

const run = (cmd, args, input) => spawnSync(cmd, args, { encoding: "utf8", input, timeout: 10_000 });

function readCrontab() {
  const r = run("crontab", ["-l"]);
  if (r.error) throw new Error("crontab is not available on this machine");
  if (r.status === 0) return r.stdout;
  if (/no crontab/i.test(r.stderr ?? "")) return "";
  // Anything else: stop rather than risk replacing the user's crontab.
  throw new Error(`crontab -l failed: ${(r.stderr || "").trim().slice(0, 120)}`);
}

function writeCrontab(text) {
  const r = text ? run("crontab", ["-"], text) : run("crontab", ["-r"]);
  if (r.error || (r.status !== 0 && text)) throw new Error(`crontab failed: ${(r.stderr || r.error?.message || "").trim().slice(0, 120)}`);
}

const uid = () => process.getuid?.() ?? 0;

/** Copy the scripts to <dir>/bin, with a VERSION file so a stale copy can be spotted. */
export function copyScripts(dir, sourceDir) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  for (const f of SCRIPT_FILES) cpSync(join(sourceDir, f), join(bin, f));
  writeFileSync(join(bin, "VERSION"), `${VERSION}
`, { mode: 0o600 });
  return bin;
}

/**
 * When the job is on and its copy of the scripts is from another plugin version, copy the current
 * ones over. The job's command line points at <dir>/bin/budget.mjs, so nothing else needs changing.
 * Returns true when it copied. Cheap when nothing is needed: one small read.
 */
export function syncJobScripts(dir, sourceDir) {
  const bin = join(dir, "bin");
  let have;
  try {
    have = readFileSync(join(bin, "VERSION"), "utf8").trim();
  } catch (e) {
    if (e.code === "ENOENT" && existsSync(join(bin, "budget.mjs"))) have = "unknown"; // a copy from before VERSION files
    else return false;
  }
  if (have === VERSION) return false;
  copyScripts(dir, sourceDir);
  return true;
}

/** Copy the scripts to <dir>/bin, then install the job for this platform. Returns a short summary. */
export function installJob({ dir, claude, node = stableNode(), sourceDir, platform = process.platform, home = homedir(), configDir = process.env.CLAUDE_CONFIG_DIR || null }) {
  if (platform !== "darwin" && platform !== "linux") throw new Error(`no background job on ${platform}; the hook still keeps the reading fresh while you work`);
  if (!claude) throw new Error("could not find the claude command (set MODEL_BUDGET_CLAUDE to its full path)");
  const bin = copyScripts(dir, sourceDir);
  const opts = { node, script: join(bin, "budget.mjs"), claude, dir, configDir };

  if (platform === "darwin") {
    const p = plistPath(home);
    mkdirSync(dirname(p), { recursive: true });
    run("/bin/launchctl", ["bootout", `gui/${uid()}/${LABEL}`]); // an earlier copy; a missing job is fine
    writeFileSync(p, plistFor(opts), { mode: 0o644 });
    // Right after a bootout, bootstrap can fail for a moment (error 5). Try a few times.
    let r;
    for (let i = 0; i < 4; i++) {
      r = run("/bin/launchctl", ["bootstrap", `gui/${uid()}`, p]);
      if (r.status === 0) break;
      run("/bin/sleep", ["1"]);
    }
    if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${(r.stderr || "").trim().slice(0, 120)}`);
    return `launchd job ${LABEL} installed: runs now and every 15 minutes`;
  }
  writeCrontab(editCrontab(readCrontab(), cronLineFor(opts)));
  return "cron job installed: runs every 15 minutes";
}

/** Remove the job and the copied scripts. Safe to run when nothing is installed. */
export function uninstallJob({ dir, platform = process.platform, home = homedir() }) {
  const done = [];
  if (platform === "darwin") {
    const p = plistPath(home);
    if (existsSync(p)) {
      run("/bin/launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
      rmSync(p, { force: true });
      done.push(`removed launchd job ${LABEL}`);
    }
  } else if (platform === "linux") {
    try {
      const cur = readCrontab();
      const next = editCrontab(cur, null);
      if (next !== cur && cur.includes(CRON_MARKER)) {
        writeCrontab(next);
        done.push("removed the cron line");
      }
    } catch {
      // no crontab command: nothing was installed
    }
  }
  rmSync(join(dir, "bin"), { recursive: true, force: true });
  return done.length ? done.join("; ") : "no background job was installed";
}

/** "on (launchd ...)", "off", or "on (cron)". */
export function jobStatus({ platform = process.platform, home = homedir() } = {}) {
  if (platform === "darwin") {
    if (!existsSync(plistPath(home))) return "off";
    const r = run("/bin/launchctl", ["print", `gui/${uid()}/${LABEL}`]);
    return r.status === 0 ? `on (launchd ${LABEL}, every 15 min)` : `installed but not loaded (re-run setup to fix)`;
  }
  if (platform === "linux") {
    try {
      return readCrontab().includes(CRON_MARKER) ? "on (cron, every 15 min)" : "off";
    } catch {
      return "off";
    }
  }
  return "not available on this platform";
}
