// model-budget: the optional transcript scan. Off unless the user turns it on (transcripts=on).
//
// Claude Code saves each session as a .jsonl transcript under <config>/projects. Each Claude reply
// in it records its time and token counts. This scan keeps and uses only those two things, from the
// last 5 weeks, and keeps only the share of tokens in each 4-hour block of the week. It never keeps,
// prints or sends any message text. It streams each file line by line, so this is the one place
// that reads more than 16 KB.

import { createReadStream, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { sharesFromEvents } from "./history.mjs";

const LOOKBACK_MS = 35 * 24 * 3_600_000;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
/** A safety cap on how many files are listed. The newest are kept. */
const MAX_FILES = 5000;
const MAX_LINE_CHARS = 2_000_000;
/** Rough relative cost per token kind. Only the shape matters: the scale comes from readings. */
const WEIGHT = { input_tokens: 1, cache_creation_input_tokens: 1.25, cache_read_input_tokens: 0.1, output_tokens: 5 };

export const projectsDir = (env = process.env, home = homedir()) => join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects");

/** The .jsonl files under projects, up to 3 folders deep (sessions keep subagent transcripts in a subfolder). */
export function transcriptFiles(root, sinceMs) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          const st = statSync(p);
          if (st.mtimeMs >= sinceMs && st.size <= MAX_FILE_BYTES) out.push({ path: p, mtimeMs: st.mtimeMs });
        } catch {}
      }
    }
  };
  walk(root, 0);
  // Newest first: if the scan runs out of time, it keeps the most recent weeks.
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES).map((f) => f.path);
}

/** One weighted usage event from a transcript line, or null. Reads nothing else from the line. */
export function eventFromLine(line, sinceMs, seen) {
  if (line.length > MAX_LINE_CHARS || !line.includes('"usage"')) return null;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const u = o?.message?.usage;
  const at = Date.parse(o?.timestamp);
  if (!u || typeof u !== "object" || !Number.isFinite(at) || at < sinceMs) return null;
  // A reply can be written over several lines with the same id: count it once.
  const id = o.message.id ?? o.requestId;
  if (typeof id === "string") {
    if (seen.has(id)) return null;
    seen.add(id);
  }
  let weight = 0;
  for (const [k, w] of Object.entries(WEIGHT)) if (typeof u[k] === "number" && u[k] > 0) weight += u[k] * w;
  return weight > 0 ? { at, weight } : null;
}

/** Scan the transcripts. Resolves to { shares, files, events } or { shares: null } when there is nothing. */
export async function scanTranscripts({ root = projectsDir(), nowMs = Date.now(), timeoutMs = 60_000 } = {}) {
  const since = nowMs - LOOKBACK_MS;
  const end = Date.now() + timeoutMs;
  const files = transcriptFiles(root, since);
  const events = [];
  const seen = new Set();
  let read = 0;
  for (const f of files) {
    if (Date.now() > end) break;
    read++;
    await new Promise((resolve) => {
      const stream = createReadStream(f, { encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const e = eventFromLine(line, since, seen);
        if (e) events.push(e);
      });
      rl.on("close", resolve);
      stream.on("error", () => resolve());
    });
  }
  return { shares: sharesFromEvents(events), files: files.length, read, events: events.length };
}
