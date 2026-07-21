import { getPairs } from "./dexscreener";

/**
 * Identify which holder addresses are liquidity pools.
 *
 * This used to classify addresses by looking up their owning program over RPC,
 * which cost ~20 getMultipleAccounts calls per holder scan (~29k/day) and still
 * missed pools. DexScreener already indexes every pair for a token, for free,
 * and a pool's vault owner is its pair address — so one request replaces all of it.
 */

/** Vaults owned by a fixed authority PDA that isn't the pair address itself. */
const KNOWN_AUTHORITIES: Record<string, string> = {
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1": "Raydium",
  "1nc1nerator11111111111111111111111111111111": "Burn address",
};

export interface PoolInfo {
  venue: string;
  liquidityUsd: number;
  volume24h: number;
  quoteSymbol: string;
}

export async function classifyPools(
  mint: string,
  owners: string[]
): Promise<Map<string, PoolInfo>> {
  const out = new Map<string, PoolInfo>();

  for (const o of owners) {
    const known = KNOWN_AUTHORITIES[o];
    if (known) {
      out.set(o, {
        venue: known,
        liquidityUsd: 0,
        volume24h: 0,
        quoteSymbol: "?",
      });
    }
  }

  try {
    const pairs = await getPairs(mint);
    const byAddress = new Map(pairs.map((p) => [p.pairAddress, p]));
    for (const o of owners) {
      const p = byAddress.get(o);
      if (!p) continue;
      out.set(o, {
        venue: p.dex,
        liquidityUsd: p.liquidityUsd,
        volume24h: p.volume24h,
        quoteSymbol: p.quoteSymbol,
      });
    }
  } catch {
    // Best-effort: without it, pools simply read as ordinary wallets.
  }

  return out;
}
