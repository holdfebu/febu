// Central config for the token analytics dashboard.

export const TOKEN_MINT =
  process.env.NEXT_PUBLIC_TOKEN_MINT ||
  "4ko5tSr5o3H4v1sFtjTSd9MPUW7yx5AFCpkNPoL6pump";

// Percentage-of-supply buckets, largest first. `min` is inclusive, `max` exclusive.
export interface BucketDef {
  key: string;
  label: string;
  emoji: string;
  min: number; // percent of supply
  max: number; // percent of supply (Infinity for top bucket)
  color: string;
}

export const BUCKETS: BucketDef[] = [
  { key: "whale", label: "Whale", emoji: "🐋", min: 5, max: Infinity, color: "#6366f1" },
  { key: "shark", label: "Shark", emoji: "🦈", min: 1, max: 5, color: "#0ea5e9" },
  { key: "dolphin", label: "Dolphin", emoji: "🐬", min: 0.5, max: 1, color: "#14b8a6" },
  { key: "fish", label: "Fish", emoji: "🐟", min: 0.1, max: 0.5, color: "#22c55e" },
  { key: "shrimp", label: "Shrimp", emoji: "🦐", min: 0.01, max: 0.1, color: "#eab308" },
  { key: "dust", label: "Dust", emoji: "🦠", min: 0, max: 0.01, color: "#a1a1aa" },
];

export function bucketForPct(pct: number): BucketDef {
  for (const b of BUCKETS) {
    if (pct >= b.min && pct < b.max) return b;
  }
  return BUCKETS[BUCKETS.length - 1];
}

// Hold-time cohorts (in days), largest-age first.
export interface AgeCohort {
  key: string;
  label: string;
  minDays: number; // inclusive
  maxDays: number; // exclusive
  color: string;
}

export const AGE_COHORTS: AgeCohort[] = [
  { key: "diamond", label: "6m+", minDays: 180, maxDays: Infinity, color: "#818cf8" },
  { key: "veteran", label: "1–6m", minDays: 30, maxDays: 180, color: "#38bdf8" },
  { key: "steady", label: "1–4w", minDays: 7, maxDays: 30, color: "#2dd4bf" },
  { key: "recent", label: "1–7d", minDays: 1, maxDays: 7, color: "#facc15" },
  { key: "fresh", label: "<24h", minDays: 0, maxDays: 1, color: "#fb7185" },
];

export function cohortForDays(days: number): AgeCohort {
  for (const c of AGE_COHORTS) {
    if (days >= c.minDays && days < c.maxDays) return c;
  }
  return AGE_COHORTS[AGE_COHORTS.length - 1];
}
