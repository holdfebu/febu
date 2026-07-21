import { getAllTokenAccounts, getTokenSupply } from "./helius";
import { BUCKETS, bucketForPct } from "./config";
import { classifyPools } from "./pools";

export interface Holder {
  rank: number;
  owner: string;
  tokenAccount: string; // representative account (largest) for hold-time lookups
  accounts: number; // how many token accounts this owner controls
  amount: number; // ui amount
  rawAmount: number;
  percentage: number;
  bucketKey: string;
  /** Protocol name if this address is a liquidity pool vault, else null. */
  pool: string | null;
  /** Rank/balance movement vs ~24h ago, attached by the API route. */
  prevRank?: number | null;
  rankDelta?: number | null;
  balancePct?: number | null;
  isNew?: boolean;
}

export interface BucketStat {
  key: string;
  label: string;
  emoji: string;
  color: string;
  rangeLabel: string;
  /** Tier bounds as % of supply. `max: null` means no upper bound. */
  min: number;
  max: number | null;
  count: number;
  holdersPct: number; // share of holders in this bucket
  supplyPct: number; // share of total supply held by this bucket
  supplyUi: number;
}

export interface HoldersPayload {
  mint: string;
  supply: { uiAmount: number; decimals: number; rawAmount: string };
  totalHolders: number;
  totalAccounts: number;
  circulatingChecked: number; // sum of ui amounts we accounted for
  holders: Holder[]; // truncated for transport (top N)
  returnedHolders: number;
  buckets: BucketStat[];
  /** Same tiers with liquidity pools removed — the real holder distribution. */
  bucketsExPools: BucketStat[];
  /** Supply burned, derived from the launch supply minus current supply. */
  burned: { amount: number; pct: number };
  /** Supply sitting in AMM liquidity pools. */
  liquidity: { amount: number; pct: number; count: number; venues: string[] };
  /** Every detected pool, ranked — including any below the table cut-off. */
  pools: Holder[];
  /** Age of the rank baseline in seconds (null until history exists). */
  rankWindowSeconds?: number | null;
  concentration: {
    top1: number;
    top10: number;
    top50: number;
    top100: number;
  };
  fetchedAt: number;
  /** Server-side rolling baseline (~1h old), attached by the API route. */
  baseline?: {
    at: number;
    ageSeconds: number;
    buckets: Record<string, number>;
    cohorts: Record<string, number>;
  } | null;
}

interface CacheEntry {
  at: number;
  data: HoldersPayload;
}
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;
// A "fresh" request still reuses a very recent scan. Without this floor, a
// crowd hitting Refresh would each kick off their own full chain scan.
const FORCE_MIN_AGE_MS = 15_000;
// How deep to look for liquidity pools. Pools hold large balances, so the
// top slice catches them all without scanning every holder.
const POOL_SCAN_DEPTH = 2000;
// pump.fun tokens launch with a fixed 1B supply; burns reduce it from there.
const LAUNCH_SUPPLY = 1_000_000_000;

// One scan at a time per mint: concurrent callers await the same promise
// instead of each starting their own (critical with many simultaneous users).
const inflight = new Map<string, Promise<HoldersPayload>>();

function rangeLabel(min: number, max: number): string {
  if (max === Infinity) return `≥ ${min}%`;
  if (min === 0) return `< ${max}%`;
  return `${min}–${max}%`;
}

function trim(data: HoldersPayload, returnLimit: number): HoldersPayload {
  return {
    ...data,
    holders: data.holders.slice(0, returnLimit),
    returnedHolders: Math.min(returnLimit, data.holders.length),
  };
}

export async function computeHolders(
  mint: string,
  returnLimit = 500,
  force = false
): Promise<HoldersPayload> {
  const hit = cache.get(mint);
  const maxAge = force ? FORCE_MIN_AGE_MS : TTL_MS;
  if (hit && Date.now() - hit.at < maxAge) {
    return trim(hit.data, returnLimit);
  }

  // Join an in-progress scan rather than starting a second one.
  const running = inflight.get(mint);
  if (running) return trim(await running, returnLimit);

  const task = buildPayload(mint).finally(() => inflight.delete(mint));
  inflight.set(mint, task);

  try {
    return trim(await task, returnLimit);
  } catch (err) {
    // If a refresh fails but we hold a usable snapshot, serve it.
    const stale = cache.get(mint);
    if (stale) return trim(stale.data, returnLimit);
    throw err;
  }
}

async function buildPayload(mint: string): Promise<HoldersPayload> {
  const [supply, accounts] = await Promise.all([
    getTokenSupply(mint),
    getAllTokenAccounts(mint),
  ]);

  const decimals = supply.decimals;
  const divisor = Math.pow(10, decimals);
  const supplyUi = supply.uiAmount || Number(supply.amount) / divisor;

  // Aggregate multiple token accounts per owner.
  const byOwner = new Map<
    string,
    { raw: number; accounts: number; topAccount: string; topAccountRaw: number }
  >();

  for (const a of accounts) {
    const cur = byOwner.get(a.owner);
    if (cur) {
      cur.raw += a.amount;
      cur.accounts += 1;
      if (a.amount > cur.topAccountRaw) {
        cur.topAccountRaw = a.amount;
        cur.topAccount = a.address;
      }
    } else {
      byOwner.set(a.owner, {
        raw: a.amount,
        accounts: 1,
        topAccount: a.address,
        topAccountRaw: a.amount,
      });
    }
  }

  const holdersAll: Holder[] = [];
  for (const [owner, v] of byOwner) {
    const rawAmount = v.raw;
    if (rawAmount <= 0) continue;
    const amount = rawAmount / divisor;
    const percentage = supplyUi > 0 ? (amount / supplyUi) * 100 : 0;
    holdersAll.push({
      rank: 0,
      owner,
      tokenAccount: v.topAccount,
      accounts: v.accounts,
      amount,
      rawAmount,
      percentage,
      bucketKey: bucketForPct(percentage).key,
      pool: null,
    });
  }

  holdersAll.sort((a, b) => b.rawAmount - a.rawAmount);
  holdersAll.forEach((h, i) => (h.rank = i + 1));

  // Pools always sit near the top by balance, so classifying the largest
  // holders catches them all in a couple of RPC calls.
  const poolMap = await classifyPools(
    holdersAll.slice(0, POOL_SCAN_DEPTH).map((h) => h.owner)
  );
  for (const h of holdersAll) h.pool = poolMap.get(h.owner) ?? null;

  const totalHolders = holdersAll.length;

  const bucketsFrom = (list: Holder[]): BucketStat[] => {
    const n = list.length;
    return BUCKETS.map((b) => {
      const inBucket = list.filter((h) => h.bucketKey === b.key);
      const supplyUiSum = inBucket.reduce((s, h) => s + h.amount, 0);
      return {
        key: b.key,
        label: b.label,
        emoji: b.emoji,
        color: b.color,
        rangeLabel: rangeLabel(b.min, b.max),
        min: b.min,
        max: b.max === Infinity ? null : b.max,
        count: inBucket.length,
        holdersPct: n ? (inBucket.length / n) * 100 : 0,
        supplyPct: supplyUi ? (supplyUiSum / supplyUi) * 100 : 0,
        supplyUi: supplyUiSum,
      };
    });
  };

  const poolHolders = holdersAll.filter((h) => h.pool);
  const realHolders = holdersAll.filter((h) => !h.pool);

  const liquidityUi = poolHolders.reduce((s, h) => s + h.amount, 0);
  const burnedAmount = Math.max(0, LAUNCH_SUPPLY - supplyUi);

  // Bucket stats over ALL holders.
  const buckets: BucketStat[] = BUCKETS.map((b) => {
    const inBucket = holdersAll.filter((h) => h.bucketKey === b.key);
    const supplyUiSum = inBucket.reduce((s, h) => s + h.amount, 0);
    return {
      key: b.key,
      label: b.label,
      emoji: b.emoji,
      color: b.color,
      rangeLabel: rangeLabel(b.min, b.max),
      min: b.min,
      // JSON has no Infinity — send null for the open-ended top tier.
      max: b.max === Infinity ? null : b.max,
      count: inBucket.length,
      holdersPct: totalHolders ? (inBucket.length / totalHolders) * 100 : 0,
      supplyPct: supplyUi ? (supplyUiSum / supplyUi) * 100 : 0,
      supplyUi: supplyUiSum,
    };
  });

  const sumPct = (arr: Holder[]) =>
    arr.reduce((s, h) => s + h.percentage, 0);

  const payload: HoldersPayload = {
    mint,
    supply: { uiAmount: supplyUi, decimals, rawAmount: supply.amount },
    totalHolders,
    totalAccounts: accounts.length,
    circulatingChecked: holdersAll.reduce((s, h) => s + h.amount, 0),
    holders: holdersAll,
    returnedHolders: totalHolders,
    buckets,
    bucketsExPools: bucketsFrom(realHolders),
    burned: {
      amount: burnedAmount,
      pct: LAUNCH_SUPPLY ? (burnedAmount / LAUNCH_SUPPLY) * 100 : 0,
    },
    pools: poolHolders,
    liquidity: {
      amount: liquidityUi,
      pct: supplyUi ? (liquidityUi / supplyUi) * 100 : 0,
      count: poolHolders.length,
      venues: [...new Set(poolHolders.map((h) => h.pool!))].sort(),
    },
    concentration: {
      top1: sumPct(holdersAll.slice(0, 1)),
      top10: sumPct(holdersAll.slice(0, 10)),
      top50: sumPct(holdersAll.slice(0, 50)),
      top100: sumPct(holdersAll.slice(0, 100)),
    },
    fetchedAt: Date.now(),
  };

  cache.set(mint, { at: Date.now(), data: payload });

  // Full payload; callers trim it to their requested limit.
  return payload;
}
