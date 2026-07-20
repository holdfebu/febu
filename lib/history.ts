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

const snapshots: Snapshot[] = [];
let capturing = false;

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

/** Cohort counts for the top 100 wallets, computed server-side. */
export async function computeCohortCounts(
  payload: HoldersPayload
): Promise<Record<string, number>> {
  const accounts = payload.holders.slice(0, 100).map((h) => h.tokenAccount);
  const times = await mapLimit(accounts, 3, resolveEarliest);
  const nowSec = Date.now() / 1000;

  const counts: Record<string, number> = {};
  for (const t of times) {
    if (t == null) continue;
    const days = (nowSec - t) / 86400;
    const key = cohortForDays(days).key;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/**
 * Record a snapshot if enough time has passed. Fire-and-forget from the API
 * route — it must never block or fail a request.
 */
export async function maybeCapture(payload: HoldersPayload): Promise<void> {
  const last = snapshots[snapshots.length - 1];
  if (last && Date.now() - last.at < CAPTURE_EVERY_MS) return;
  if (capturing) return;

  capturing = true;
  try {
    const buckets: Record<string, number> = {};
    for (const b of payload.buckets) buckets[b.key] = b.count;
    const cohorts = await computeCohortCounts(payload);
    record({ at: Date.now(), buckets, cohorts });
  } catch {
    // Snapshotting is best-effort.
  } finally {
    capturing = false;
  }
}
