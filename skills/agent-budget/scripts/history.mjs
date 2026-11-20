// model-budget: the user's own usage pattern. Pure functions, no I/O.
//
// history.json keeps how much of the weekly limit was used in each 4-hour block of the week
// (7 days x 6 blocks = 42, in local time), for the current week and the last 6 weeks. Each refresh
// adds the change since the last reading. Usage comes as whole percents, so blocks are 4 hours, not 1.
// From that come:
// - shares: the part of a usual week that falls in each block, so pace can follow the user's own
//   rhythm (quiet nights and weekends) instead of a straight line;
// - the day check: whether today is far heavier or quieter than usual by this time of day.

export const BLOCKS = 42;
export const BLOCK_MS = 4 * 3_600_000;
export const WEEK_MS = 7 * 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;
/** Completed weeks kept. The median of 6 shrugs off one odd week, and a lasting change wins in 3 or 4. */
export const KEEP_WEEKS = 6;
/** Weeks needed before the readings pattern is used (and before any day is called heavy or quiet). */
export const MIN_WEEKS = 2;
/** A week counts once this share of its blocks had readings. */
const MIN_COVERED = 0.8;
/** Mix in a little of a flat week, so a block that is usually empty never counts as zero time. */
const FLAT_MIX = 0.15;
/** A reset time that moves forward by at least this means a new week. A smaller move is the same week. */
const NEW_WEEK_MS = 6 * 24 * 3_600_000;
/**
 * A rise of more than this many points, spread over a gap longer than one block, is uncertain: the
 * blocks it covers count as half seen. A rise of 0 or 1 (rounding) over a gap is plain quiet time.
 */
const SURE_POINTS = 1;
const UNSURE_SEEN = 0.5;
/**
 * A day is heavy or quiet when it is this far outside the usual band: at least DAY_MIN_POINTS, and at
 * least DAY_MADS spreads, and at least DAY_SHARE of the usual itself.
 */
export const DAY_MIN_POINTS = 3;
export const DAY_MADS = 3;
export const DAY_SHARE = 0.5;
/** The most a heavy (or least a quiet) day scales the rest of today. */
const DAY_FACTOR_MAX = 3;
const DAY_FACTOR_MIN = 1 / 3;

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isIso = (v) => typeof v === "string" && v.length <= 64 && !Number.isNaN(Date.parse(v));
const zeros = () => new Array(BLOCKS).fill(0);
const round2 = (n) => Math.round(n * 100) / 100;
const localOffsetMs = (ms) => -new Date(ms).getTimezoneOffset() * 60_000;

/** Block 0 is Sunday 00:00 to 04:00 local time. `tz` gives the local offset in ms (for tests). */
export function blockIndex(ms, tz = localOffsetMs) {
  const local = new Date(ms + tz(ms));
  return local.getUTCDay() * 6 + Math.floor(local.getUTCHours() / 4);
}

/** The start (in UTC ms) of the block that holds `ms`. */
export function blockStart(ms, tz = localOffsetMs) {
  const off = tz(ms);
  return Math.floor((ms + off) / BLOCK_MS) * BLOCK_MS - off;
}

/** Local midnight at or before `ms`. */
export function dayStart(ms, tz = localOffsetMs) {
  const off = tz(ms);
  return Math.floor((ms + off) / DAY_MS) * DAY_MS - off;
}

/** Split [from, to) into block pieces: [{ block, ms }]. */
export function pieces(fromMs, toMs, tz = localOffsetMs) {
  const out = [];
  let t = fromMs;
  while (t < toMs) {
    const end = Math.min(toMs, blockStart(t, tz) + BLOCK_MS);
    out.push({ block: blockIndex(t, tz), ms: end - t });
    t = end;
  }
  return out;
}

export const emptyHistory = () => ({ version: 1, last: null, current: { reset: null, v: zeros(), c: zeros() }, weeks: [], transcripts: null });

const numArray = (a, max) => Array.isArray(a) && a.length === BLOCKS && a.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max);
const validWeek = (w) => isObj(w) && numArray(w.v, 1000) && numArray(w.c, 1);

/** Shape check for history.json read from disk. A bad file starts a fresh history. */
export function parseHistory(raw) {
  const h = emptyHistory();
  if (!isObj(raw) || raw.version !== 1) return h;
  if (isObj(raw.last) && isIso(raw.last.at) && isIso(raw.last.resets_at) && typeof raw.last.used === "number" && Number.isFinite(raw.last.used)) {
    h.last = { at: raw.last.at, used: raw.last.used, resets_at: raw.last.resets_at };
  }
  if (validWeek(raw.current) && (raw.current.reset === null || isIso(raw.current.reset))) h.current = { reset: raw.current.reset, v: [...raw.current.v], c: [...raw.current.c] };
  if (Array.isArray(raw.weeks)) h.weeks = raw.weeks.filter(validWeek).slice(0, KEEP_WEEKS).map((w) => ({ v: [...w.v], c: [...w.c] }));
  if (isObj(raw.transcripts) && isIso(raw.transcripts.scanned_at) && (raw.transcripts.shares === null || numArray(raw.transcripts.shares, 1))) {
    h.transcripts = { scanned_at: raw.transcripts.scanned_at, shares: raw.transcripts.shares ? [...raw.transcripts.shares] : null };
  }
  return h;
}

/**
 * Add `amount` over [from, to), split by time, and mark those blocks as seen. A real rise over a gap
 * longer than one block is a guess about when it happened, so those blocks count as half seen.
 */
function spreadInto(week, fromMs, toMs, amount, tz) {
  const ps = pieces(fromMs, toMs, tz);
  const total = ps.reduce((s, p) => s + p.ms, 0);
  const seen = toMs - fromMs > BLOCK_MS && amount > SURE_POINTS ? UNSURE_SEEN : 1;
  for (const p of ps) {
    if (total > 0) week.v[p.block] = round2(week.v[p.block] + (amount * p.ms) / total);
    week.c[p.block] = Math.max(week.c[p.block], seen);
  }
}

/**
 * The history after one weekly reading: { at, used, resets_at } (ISO times, used in %).
 * - Same week: the rise since the highest reading so far is spread over the time since the last
 *   reading. A drop (a rounding wobble) adds nothing. A reset time that moves by less than 6 days
 *   (a plan change) is still the same week.
 * - New week (the reset time moved forward by 6 days or more): the time from the last reading to the
 *   old reset counts as quiet, the week is closed and kept, and the new reading's % is spread from
 *   the reset to now.
 * - Repeated or slightly older readings change nothing. A reading far older than the last (the clock
 *   was set back) restarts from it.
 */
export function recordReading(history, reading, tz = localOffsetMs) {
  const h = structuredClone(history ?? emptyHistory());
  const at = Date.parse(reading.at);
  const reset = Date.parse(reading.resets_at);
  if (!Number.isFinite(at) || !Number.isFinite(reset) || typeof reading.used !== "number") return h;
  const last = h.last;
  const lastAt = last ? Date.parse(last.at) : NaN;
  if (last && at <= lastAt) {
    // The clock went back a long way: trust the new time and carry on from here.
    if (lastAt - at > BLOCK_MS) h.last = { at: reading.at, used: reading.used, resets_at: reading.resets_at };
    return h;
  }

  const oldReset = last ? Date.parse(last.resets_at) : NaN;
  const newWeek = !last || reset - oldReset >= NEW_WEEK_MS;
  if (!newWeek) {
    spreadInto(h.current, lastAt, at, Math.max(0, reading.used - last.used), tz);
    h.last = { at: reading.at, used: Math.max(last.used, reading.used), resets_at: reading.resets_at };
  } else {
    if (last) {
      // Nothing was read between the last reading and the reset: count it as quiet, not unseen.
      if (oldReset > lastAt) spreadInto(h.current, lastAt, Math.min(oldReset, at), 0, tz);
      if (h.current.c.some((c) => c)) h.weeks = [{ v: h.current.v, c: h.current.c }, ...h.weeks].slice(0, KEEP_WEEKS);
    }
    h.current = { reset: reading.resets_at, v: zeros(), c: zeros() };
    const weekStart = reset - WEEK_MS;
    // On the first reading ever, the use so far has no time to it: start the record here.
    if (last && weekStart < at) spreadInto(h.current, Math.max(weekStart, lastAt), at, Math.max(0, reading.used), tz);
    h.last = { at: reading.at, used: reading.used, resets_at: reading.resets_at };
  }
  h.current.reset = reading.resets_at;
  return h;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mad = (xs) => {
  const m = median(xs);
  return m === null ? null : median(xs.map((x) => Math.abs(x - m)));
};

/** Completed weeks with readings for most of their blocks (a half-seen block counts half). */
export const goodWeeks = (h) => h.weeks.filter((w) => w.c.reduce((s, c) => s + c, 0) >= MIN_COVERED * BLOCKS);

/**
 * The part of a usual week in each block (summing to 1), and where it came from:
 * - "readings": the median of each block over the good weeks, once there are at least MIN_WEEKS;
 * - "transcripts": the token pattern from Claude Code's transcripts, when the scan is on;
 * - null: not enough history, so pace uses a straight line.
 */
export function patternShares(h, { transcripts = false } = {}) {
  const weeks = goodWeeks(h);
  let raw = null;
  let source = null;
  if (weeks.length >= MIN_WEEKS) {
    raw = Array.from({ length: BLOCKS }, (_, b) => median(weeks.filter((w) => w.c[b] > 0).map((w) => w.v[b])) ?? 0);
    source = "readings";
  } else if (transcripts && h.transcripts?.shares) {
    raw = h.transcripts.shares;
    source = "transcripts";
  }
  const sum = raw ? raw.reduce((s, x) => s + x, 0) : 0;
  if (!raw || !(sum > 0)) return null;
  const shares = raw.map((x) => (1 - FLAT_MIX) * (x / sum) + FLAT_MIX / BLOCKS);
  return { source, weeks: weeks.length, shares };
}

/** The share of a usual week that falls in [from, to). */
export function shareBetween(shares, fromMs, toMs, tz = localOffsetMs) {
  if (!(toMs > fromMs)) return 0;
  let s = 0;
  for (const p of pieces(fromMs, toMs, tz)) s += (shares[p.block] * p.ms) / BLOCK_MS;
  return s;
}

/**
 * Today against usual, by the time of the reading. Needs MIN_WEEKS good weeks.
 * { kind: "heavy" | "quiet" | "usual", actual, typical, factor } in weekly %, or null.
 *
 * Use inside a 4-hour block can come at any time in it, so "usual by now" is a band: from the usual
 * by the start of the current block to the usual by its end. A day is heavy only when it is well
 * above the top of the band, and quiet only when well below the bottom. `factor` scales the rest of
 * today in the pace. It starts at 1 at the edge and grows with the distance past it, between 1/3
 * and 3, so the mode never jumps on one point.
 */
export function dayCheck(h, readMs, tz = localOffsetMs) {
  const weeks = goodWeeks(h);
  if (weeks.length < MIN_WEEKS || !h.current.reset) return null;
  const from = dayStart(readMs, tz);
  const weekStart = Date.parse(h.current.reset) - WEEK_MS;
  if (from < weekStart) return null; // the week reset today: today's early blocks belong to last week
  const today = pieces(from, readMs, tz);
  if (!today.length) return null;
  // This week so far: every block of today in full, since it only holds use up to the reading.
  const actual = round2(today.reduce((s, p) => s + h.current.v[p.block], 0));
  // Earlier weeks: by the start of the current block, by its end, and pro rata (to show).
  const last = today[today.length - 1];
  const done = today.slice(0, -1);
  const upTo = (w, part) => done.reduce((s, p) => s + w.v[p.block], 0) + w.v[last.block] * part;
  const lower = median(weeks.map((w) => upTo(w, 0)));
  const upper = median(weeks.map((w) => upTo(w, 1)));
  const proRata = weeks.map((w) => upTo(w, last.ms / BLOCK_MS));
  const typical = round2(median(proRata));
  const spread = mad(proRata);
  const gapAbove = Math.max(DAY_MIN_POINTS, DAY_MADS * spread, DAY_SHARE * upper);
  const gapBelow = Math.max(DAY_MIN_POINTS, DAY_MADS * spread, DAY_SHARE * lower);
  let kind = "usual";
  let factor = 1;
  if (actual >= upper + gapAbove) {
    kind = "heavy";
    factor = Math.min(DAY_FACTOR_MAX, 1 + (actual - upper - gapAbove) / (upper + DAY_MIN_POINTS));
  } else if (actual <= lower - gapBelow) {
    kind = "quiet";
    factor = Math.max(DAY_FACTOR_MIN, 1 - (lower - gapBelow - actual) / (lower + DAY_MIN_POINTS));
  }
  return { kind, actual, typical, factor: Math.round(factor * 100) / 100 };
}

/**
 * Pace from the user's own pattern: the % the window reaches at its reset, if the rest of the week
 * goes like a usual week. A heavy or quiet day scales the rest of today by its factor.
 * null until 10 % of a usual week has gone.
 */
export function patternPace(used, resetMs, readMs, windowMin, shares, day = null, tz = localOffsetMs) {
  const start = resetMs - windowMin * 60_000;
  if (!(readMs > start && readMs < resetMs)) return null;
  const gone = shareBetween(shares, start, readMs, tz);
  if (gone < 0.1) return null;
  const projected = used / gone;
  const factor = day?.factor ?? 1;
  const restToday = shareBetween(shares, readMs, Math.min(resetMs, dayStart(readMs, tz) + DAY_MS), tz);
  return Math.round(Math.max(used, projected + (factor - 1) * projected * restToday));
}

/** The token shares per block from transcript usage events: [{ at: ms, weight }]. */
export function sharesFromEvents(events, tz = localOffsetMs) {
  const sums = zeros();
  for (const e of events) sums[blockIndex(e.at, tz)] += e.weight;
  const total = sums.reduce((s, x) => s + x, 0);
  return total > 0 ? sums.map((x) => Math.round((x / total) * 1e5) / 1e5) : null;
}
