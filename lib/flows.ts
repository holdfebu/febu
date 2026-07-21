import { TOKEN_MINT } from "./config";

/**
 * Lifetime buy/sell totals per wallet, from Helius's parsed transaction feed.
 * Refreshed on a slow schedule (every 8h) because it walks full history.
 */

export interface Flow {
  bought: number;
  sold: number;
  /** True when bought - sold matches the on-chain balance, i.e. full history. */
  reconciled: boolean;
  at: number;
}

const REFRESH_MS = 8 * 60 * 60 * 1000; // every 8 hours
const TOP_N = 50; // how many wallets to track
const PAGE = 100; // Helius max per page
const MAX_PAGES = 25; // safety cap: 2,500 txs per wallet
const CONCURRENCY = 2;

const flows = new Map<string, Flow>();
let lastRun = 0;
let running = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchFlow(owner: string, balance: number): Promise<Flow | null> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return null;

  let bought = 0;
  let sold = 0;
  let before: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `https://api.helius.xyz/v0/addresses/${owner}/transactions` +
      `?api-key=${key}&limit=${PAGE}${before ? `&before=${before}` : ""}`;

    let txs: Array<{
      signature: string;
      tokenTransfers?: Array<{
        mint: string;
        tokenAmount: number;
        fromUserAccount: string;
        toUserAccount: string;
      }>;
    }> = [];

    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, { cache: "no-store" });
      if (res.status === 429 || res.status >= 500) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!res.ok) return null;
      txs = await res.json();
      break;
    }

    if (!txs.length) break;

    for (const t of txs) {
      for (const tt of t.tokenTransfers ?? []) {
        if (tt.mint !== TOKEN_MINT) continue;
        if (tt.toUserAccount === owner) bought += tt.tokenAmount;
        if (tt.fromUserAccount === owner) sold += tt.tokenAmount;
      }
    }

    before = txs[txs.length - 1].signature;
    if (txs.length < PAGE) break;
    await sleep(120);
  }

  // A wallet holding tokens must have received them. Finding nothing means the
  // acquisition predates our page budget, so report unknown rather than "0" —
  // a zero next to a multi-million balance reads as fact and isn't one.
  if (bought === 0 && balance > 0) return null;

  // If net matches the balance we've seen the wallet's whole history.
  const net = bought - sold;
  const reconciled = Math.abs(net - balance) < Math.max(1, balance * 0.001);

  return { bought, sold, reconciled, at: Date.now() };
}

export function getFlow(owner: string): Flow | null {
  return flows.get(owner) ?? null;
}

export function flowsAgeSeconds(): number | null {
  return lastRun ? Math.round((Date.now() - lastRun) / 1000) : null;
}

/**
 * Refresh buy/sell totals for the top wallets if the last run is stale.
 * Fire-and-forget from the API route; it must never block a request.
 */
export async function maybeRefreshFlows(
  holders: Array<{ owner: string; amount: number; pool?: string | null }>
): Promise<void> {
  if (running) return;
  if (lastRun && Date.now() - lastRun < REFRESH_MS) return;

  running = true;
  try {
    // Skip AMM vaults: they churn constantly, never reconcile, and would burn
    // the page budget. "Bought/sold" is meaningless for a pool anyway.
    const targets = holders.filter((h) => !h.pool).slice(0, TOP_N);
    let idx = 0;

    const workers = new Array(CONCURRENCY).fill(0).map(async () => {
      while (idx < targets.length) {
        const t = targets[idx++];
        const flow = await fetchFlow(t.owner, t.amount).catch(() => null);
        if (flow) flows.set(t.owner, flow);
        await sleep(200);
      }
    });

    await Promise.all(workers);
    lastRun = Date.now();
  } finally {
    running = false;
  }
}
