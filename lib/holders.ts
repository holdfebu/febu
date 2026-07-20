import { getAllTokenAccounts, getTokenSupply } from "./helius";
import { BUCKETS, bucketForPct } from "./config";

export interface Holder {
  rank: number;
  owner: string;
  tokenAccount: string; // representative account (largest) for hold-time lookups
  accounts: number; // how many token accounts this owner controls
  amount: number; // ui amount
  rawAmount: number;
  percentage: number;
  bucketKey: string;
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
    });
  }

  holdersAll.sort((a, b) => b.rawAmount - a.rawAmount);
  holdersAll.forEach((h, i) => (h.rank = i + 1));

  const totalHolders = holdersAll.length;

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
