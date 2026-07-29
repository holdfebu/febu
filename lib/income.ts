// Server-only: tracks the money flowing through the febu dev wallet.
//
// The dev wallet is an autonomous agent. On the income side it periodically
// claims the creator fees it accrues on pump.fun (bonding curve) and PumpSwap
// (AMM) — those show up as wallet-signed, non-trade transactions Helius tags
// source=PUMP_FUN / PUMP_AMM that net SOL in. On the spend side it sends SOL
// out to three buckets:
//   - Fireblocks : cashing out to custody (a known address)
//   - pump.fun   : buying / creating its two tokens
//   - Rent Humans: everything else — paying people to do tasks
//
// The wallet's history is small (~700 txs), so we just crawl the whole thing
// each refresh and cache the result. The headline number is the live SOL
// balance (ground truth), not a reconstructed sum.

import { getSolBalance } from "@/lib/helius";

const HELIUS_KEY = process.env.HELIUS_API_KEY;

export const DEV_WALLET = "ApWpkd8tpPTdTFNihoYuF5en8Y27TQn4LAQTvvmf8faG";
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Pump-family sources, as classified by Helius' enhanced-transaction parser.
const PUMP_SOURCES = new Set(["PUMP_FUN", "PUMP_AMM"]);
// Types that move SOL for reasons other than a fee claim — exclude them.
const NON_CLAIM_TYPES = new Set([
  "SWAP",
  "CREATE",
  "CREATE_POOL",
  "ADD_LIQUIDITY",
  "REMOVE_LIQUIDITY",
  "BUY",
  "SELL",
]);

// Known Fireblocks custody deposit address for this wallet (Arkham: "Fireblocks
// Custody (2o8fa)"). Extend if the agent starts using more custody addresses.
const FIREBLOCKS = new Set(["2o8faRejF81xFFDAuGrRkhsEytEZfeC7LNLq6aX4Mkse"]);

const LAMPORTS = 1e9;
const DUST_SOL = 0.0005; // ignore outflows smaller than this
// A real fee claim vs. rent-dust from closing an empty account. PumpSwap fees
// paid in wrapped SOL show up as large CLOSE_ACCOUNT unwraps; this floor keeps
// those while dropping the ~0.002 SOL rent reclaims.
const CLAIM_MIN_SOL = 0.05;

export interface FeeClaim {
  signature: string;
  timestamp: number; // unix seconds
  sol: number; // net SOL into the wallet
  venue: "pump" | "pumpswap"; // bonding-curve vs AMM fees
}

export interface OutflowCat {
  sol: number; // total SOL sent to this category
  count: number; // number of transactions
}

export interface Outflows {
  fireblocks: OutflowCat;
  pump: OutflowCat;
  humans: OutflowCat;
}

export interface IncomePayload {
  wallet: string;
  balanceSol: number; // live wallet SOL balance — the headline "fees collected"
  claims: FeeClaim[]; // most recent first (native-SOL pump claims we can detect)
  totalSol: number; // sum of the detectable native claims (a subset of income)
  count: number;
  last: FeeClaim | null;
  sol24h: number;
  count24h: number;
  outflows: Outflows;
  solPrice: number | null; // USD per SOL
  at: number; // unix ms
}

interface HeliusTx {
  signature: string;
  timestamp: number;
  type: string;
  source: string;
  feePayer: string;
  nativeTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number; // lamports
  }>;
}

function classifyClaim(tx: HeliusTx, netInSol: number): FeeClaim | null {
  // Fee income lands two ways: native SOL claims Helius tags PUMP_FUN/PUMP_AMM,
  // and PumpSwap fees paid in wrapped SOL that the wallet later unwraps via a
  // CLOSE_ACCOUNT. Both are wallet-signed, non-trade, and net SOL in — so match
  // on those properties rather than the pump source alone (which missed the
  // unwraps, leaving "last claim" days stale).
  if (NON_CLAIM_TYPES.has(tx.type)) return null; // exclude buys/sells/swaps
  if (tx.feePayer !== DEV_WALLET) return null; // self-signed only
  if (netInSol < CLAIM_MIN_SOL) return null;
  return {
    signature: tx.signature,
    timestamp: tx.timestamp,
    sol: netInSol,
    venue: tx.source === "PUMP_FUN" ? "pump" : "pumpswap",
  };
}

function emptyOutflows(): Outflows {
  return {
    fireblocks: { sol: 0, count: 0 },
    pump: { sol: 0, count: 0 },
    humans: { sol: 0, count: 0 },
  };
}

// Crawl the wallet's whole transaction history once, pulling out fee claims
// (income) and categorized SOL outflows (spend).
async function crawl(): Promise<{ claims: FeeClaim[]; outflows: Outflows }> {
  if (!HELIUS_KEY) throw new Error("HELIUS_API_KEY is not set.");
  const claims: FeeClaim[] = [];
  const out = emptyOutflows();
  let before: string | undefined;

  for (let page = 0; page < 15; page++) {
    const url = new URL(
      `https://api.helius.xyz/v0/addresses/${DEV_WALLET}/transactions`
    );
    url.searchParams.set("api-key", HELIUS_KEY);
    url.searchParams.set("limit", "100");
    if (before) url.searchParams.set("before", before);

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      if (claims.length || out.pump.count) break; // keep what we have
      throw new Error(`Helius transactions HTTP ${res.status}`);
    }
    const txs = (await res.json()) as HeliusTx[];
    if (!Array.isArray(txs) || txs.length === 0) break;

    for (const tx of txs) {
      // Net SOL and per-recipient SOL out, in one pass over nativeTransfers.
      let net = 0;
      const outByRecip = new Map<string, number>();
      for (const n of tx.nativeTransfers ?? []) {
        if (n.toUserAccount === DEV_WALLET) net += n.amount;
        if (n.fromUserAccount === DEV_WALLET) {
          net -= n.amount;
          outByRecip.set(
            n.toUserAccount,
            (outByRecip.get(n.toUserAccount) ?? 0) + n.amount
          );
        }
      }
      const netInSol = net / LAMPORTS;

      // Income: fee claims.
      const claim = classifyClaim(tx, netInSol);
      if (claim) claims.push(claim);

      // Spend: total SOL leaving the wallet on this tx, bucketed.
      const totalOut =
        [...outByRecip.values()].reduce((s, v) => s + v, 0) / LAMPORTS;
      if (totalOut >= DUST_SOL) {
        if (PUMP_SOURCES.has(tx.source)) {
          out.pump.sol += totalOut;
          out.pump.count += 1;
        } else {
          // Split this tx's outbound SOL between Fireblocks and humans by
          // recipient (a single tx almost always has one destination).
          let toFireblocks = 0;
          let toHumans = 0;
          for (const [recip, lamports] of outByRecip) {
            const sol = lamports / LAMPORTS;
            if (sol < DUST_SOL) continue;
            if (FIREBLOCKS.has(recip)) toFireblocks += sol;
            else toHumans += sol;
          }
          if (toFireblocks >= DUST_SOL) {
            out.fireblocks.sol += toFireblocks;
            out.fireblocks.count += 1;
          }
          if (toHumans >= DUST_SOL) {
            out.humans.sol += toHumans;
            out.humans.count += 1;
          }
        }
      }
    }

    before = txs[txs.length - 1]?.signature;
    if (txs.length < 100) break; // reached the oldest page
  }

  claims.sort((a, b) => b.timestamp - a.timestamp);
  return { claims, outflows: out };
}

async function fetchSolPrice(): Promise<number | null> {
  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, { usdPrice?: number } | null>;
    const p = json[SOL_MINT]?.usdPrice;
    return typeof p === "number" ? p : null;
  } catch {
    return null;
  }
}

// Shared across all viewers so one crawl serves everyone; refresh every ~8 min
// so the balance and last-claim stay well within the 20-minute freshness bar.
const CACHE_TTL_MS = 8 * 60_000;
let cache: { at: number; data: IncomePayload } | null = null;
let inflight: Promise<IncomePayload> | null = null;

async function build(): Promise<IncomePayload> {
  const [{ claims, outflows }, solPrice, balanceSol] = await Promise.all([
    crawl(),
    fetchSolPrice(),
    getSolBalance(DEV_WALLET).catch(() => 0),
  ]);

  const now = Date.now();
  const dayAgo = Math.floor(now / 1000) - 86_400;
  const recent = claims.filter((c) => c.timestamp >= dayAgo);
  return {
    wallet: DEV_WALLET,
    balanceSol,
    claims: claims.slice(0, 50),
    totalSol: claims.reduce((s, c) => s + c.sol, 0),
    count: claims.length,
    last: claims[0] ?? null,
    sol24h: recent.reduce((s, c) => s + c.sol, 0),
    count24h: recent.length,
    outflows,
    solPrice,
    at: now,
  };
}

export async function getIncome(): Promise<IncomePayload> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  if (inflight) return inflight;

  inflight = build()
    .then((data) => {
      cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inflight = null;
    });

  try {
    return await inflight;
  } catch (err) {
    if (cache) return cache.data; // serve stale rather than error
    throw err;
  }
}
