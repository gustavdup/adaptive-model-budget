// Every CLI run in the tests uses this environment, so no test can touch a real job or real files:
// - HOME is an empty temp folder, so no real launchd plist (or ~/.config, or ~/.claude) is found;
// - PATH is an empty temp folder, so no real `crontab` can run, wherever node is installed
//   (node itself is started by its absolute path);
// - CLAUDE_CONFIG_DIR points into the temp HOME, so no real transcripts are read.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made = [];
process.on("exit", () => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A temp folder that is removed when the test process exits. */
export function tempDir(prefix = "model-budget-test-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

export function safeEnv(dir, extra = {}) {
  const home = tempDir("model-budget-home-");
  const path = tempDir("model-budget-path-");
  return { ...process.env, HOME: home, PATH: path, CLAUDE_CONFIG_DIR: join(home, ".claude"), MODEL_BUDGET_DIR: dir, MODEL_BUDGET_CLAUDE: "/nonexistent/claude", ...extra };
}
