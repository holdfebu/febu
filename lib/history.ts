import type { HoldersPayload } from "./holders";
import { cohortForDays } from "./config";
import { resolveEarliest, mapLimit } from "./holdtime";

export interface Snapshot {
  at: number;
  buckets: Record<string, number>;
  cohorts: Record<string, number>;
}

export interface Baseline {
  at: number;
  ageSeconds: number;
  buckets: Record<string, number>;
  cohorts: Record<string, number>;
}

const TARGET_AGE_MS = 60 * 60 * 1000; // aim to compare against ~1h ago
const KEEP_MS = 6 * 60 * 60 * 1000; // retain 6h of history
const CAPTURE_EVERY_MS = 5 * 60 * 1000; // record a snapshot every 5 min

// A snapshot must resolve at least this share of the top 100 to be trusted.
const MIN_RESOLVED_RATIO = 0.85;
// How soon a failed capture attempt may be retried.
const RETRY_AFTER_MS = 45_000;

const snapshots: Snapshot[] = [];
let capturing = false;
let lastAttemptAt = 0;

/* ---------------- Rank / balance history ----------------
 * Kept separate from the cohort snapshots above: ranks don't depend on
 * hold-time lookups, so they must not be gated on cohort completeness.
 */
interface RankSnapshot {
  at: number;
  entries: Record<string, { r: number; a: number }>; // owner -> rank, amount
}

const RANK_TARGET_AGE_MS = 24 * 60 * 60 * 1000; // compare against ~24h ago
const RANK_KEEP_MS = 26 * 60 * 60 * 1000;
const RANK_EVERY_MS = 5 * 60 * 1000;
const RANK_DEPTH = 250;

const rankSnapshots: RankSnapshot[] = [];

export function recordRanks(holders: Array<{ owner: string; rank: number; amount: number }>) {
  const last = rankSnapshots[rankSnapshots.length - 1];
  if (last && Date.now() - last.at < RANK_EVERY_MS) return;

  const entries: RankSnapshot["entries"] = {};
  for (const h of holders.slice(0, RANK_DEPTH)) {
    entries[h.owner] = { r: h.rank, a: h.amount };
  }
  rankSnapshots.push({ at: Date.now(), entries });

  const cutoff = Date.now() - RANK_KEEP_MS;
  while (rankSnapshots.length && rankSnapshots[0].at < cutoff) rankSnapshots.shift();
}

/** Oldest snapshot at least 24h old, else the oldest we have. */
function rankBaseline(): RankSnapshot | null {
  if (!rankSnapshots.length) return null;
  const target = Date.now() - RANK_TARGET_AGE_MS;
  let best: RankSnapshot | null = null;
  for (const s of rankSnapshots) {
    if (s.at <= target) best = s;
    else break;
  }
  return best ?? rankSnapshots[0];
}

export interface Movement {
  prevRank: number | null;
  rankDelta: number | null; // positive = moved up the leaderboard
  balancePct: number | null;
  isNew: boolean;
}

export function movementFor(owner: string, rank: number, amount: number): Movement {
  const base = rankBaseline();
  const prev = base?.entries[owner];
  if (!base) return { prevRank: null, rankDelta: null, balancePct: null, isNew: false };
  if (!prev) return { prevRank: null, rankDelta: null, balancePct: null, isNew: true };
  return {
    prevRank: prev.r,
    rankDelta: prev.r - rank, // #10 -> #50 gives -40
    balancePct: prev.a > 0 ? ((amount - prev.a) / prev.a) * 100 : null,
    isNew: false,
  };
}

/** How much history we actually have, so the UI can label the window. */
export function rankWindowSeconds(): number | null {
  const base = rankBaseline();
  return base ? Math.round((Date.now() - base.at) / 1000) : null;
}

function record(s: Snapshot): void {
  snapshots.push(s);
  const cutoff = Date.now() - KEEP_MS;
  while (snapshots.length && snapshots[0].at < cutoff) snapshots.shift();
}

/**
 * The newest snapshot that is at least TARGET_AGE_MS old. If the process
 * hasn't been up that long yet, fall back to the oldest one we have so new
 * visitors still see real movement (over a shorter window).
 */
export function getBaseline(): Baseline | null {
  if (!snapshots.length) return null;
  const target = Date.now() - TARGET_AGE_MS;

  let best: Snapshot | null = null;
  for (const s of snapshots) {
    if (s.at <= target) best = s;
    else break;
  }
  const chosen = best ?? snapshots[0];

  return {
    at: chosen.at,
    ageSeconds: Math.max(0, Math.round((Date.now() - chosen.at) / 1000)),
    buckets: chosen.buckets,
    cohorts: chosen.cohorts,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cohort counts for the top 100 wallets, computed server-side.
 * Returns the counts plus how many wallets actually resolved, so callers can
 * reject an incomplete result rather than storing it.
 */
export async function computeCohortCounts(
  payload: HoldersPayload
): Promise<{ counts: Record<string, number>; resolved: number; total: number }> {
  const accounts = payload.holders.slice(0, 100).map((h) => h.tokenAccount);

  // Low concurrency: a cold cache means every one of these is a real
  // multi-page signature crawl, and Helius will rate-limit a burst.
  const times = await mapLimit(accounts, 2, resolveEarliest);

  // Retry whatever failed — on a cold server most misses are transient limits.
  for (let round = 0; round < 2; round++) {
    const missingIdx = times
      .map((t, i) => (t == null ? i : -1))
      .filter((i) => i >= 0);
    if (!missingIdx.length) break;
    await sleep(2000 * (round + 1));
    const retried = await mapLimit(
      missingIdx.map((i) => accounts[i]),
      2,
      resolveEarliest
    );
    missingIdx.forEach((idx, k) => {
      if (retried[k] != null) times[idx] = retried[k];
    });
  }

  const nowSec = Date.now() / 1000;
  const counts: Record<string, number> = {};
  let resolved = 0;
  for (const t of times) {
    if (t == null) continue;
    resolved++;
    const days = (nowSec - t) / 86400;
    const key = cohortForDays(days).key;
    counts[key] = (counts[key] || 0) + 1;
  }
  return { counts, resolved, total: accounts.length };
}

/**
 * Record a snapshot if enough time has passed. Fire-and-forget from the API
 * route — it must never block or fail a request.
 */
export async function maybeCapture(payload: HoldersPayload): Promise<void> {
  const last = snapshots[snapshots.length - 1];
  if (last && Date.now() - last.at < CAPTURE_EVERY_MS) return;
  if (capturing) return;
  // Independent throttle so failed attempts retry soon, but don't hammer.
  if (Date.now() - lastAttemptAt < RETRY_AFTER_MS) return;

  // The payload may have been trimmed to a caller's ?limit=. Snapshotting a
  // short list would record a baseline built from a handful of wallets.
  const expected = Math.min(100, payload.totalHolders);
  if (payload.holders.length < expected) return;

  capturing = true;
  lastAttemptAt = Date.now();
  try {
    const buckets: Record<string, number> = {};
    for (const b of payload.buckets) buckets[b.key] = b.count;

    const { counts, resolved, total } = await computeCohortCounts(payload);

    // A partially-resolved cohort set would poison every future delta
    // (e.g. baseline 2 vs current 71 reads as +3450%). Skip it and retry
    // later rather than storing a bad baseline permanently.
    if (resolved < Math.ceil(total * MIN_RESOLVED_RATIO)) return;

    record({ at: Date.now(), buckets, cohorts: counts });
  } catch {
    // Snapshotting is best-effort.
  } finally {
    capturing = false;
  }
}
