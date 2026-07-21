/**
 * DexScreener pair data. Free, no API key, and it already knows every pool for
 * a token — which is far cheaper and more complete than classifying holder
 * addresses against AMM program IDs over RPC.
 */

export interface Pair {
  pairAddress: string;
  dex: string;
  quoteSymbol: string;
  liquidityUsd: number;
  volume24h: number;
}

const TTL_MS = 60_000;
let cache: { at: number; mint: string; pairs: Pair[] } | null = null;
let inflight: Promise<Pair[]> | null = null;

const DEX_NAMES: Record<string, string> = {
  pumpswap: "PumpSwap",
  meteora: "Meteora",
  orca: "Orca",
  raydium: "Raydium",
  lifinity: "Lifinity",
  phoenix: "Phoenix",
};

async function fetchPairs(mint: string): Promise<Pair[]> {
  const res = await fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
    { cache: "no-store", headers: { Accept: "application/json" } }
  );
  if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);

  const json = (await res.json()) as {
    pairs?: Array<{
      pairAddress?: string;
      dexId?: string;
      baseToken?: { symbol?: string; address?: string };
      quoteToken?: { symbol?: string };
      liquidity?: { usd?: number };
      volume?: { h24?: number };
    }> | null;
  };

  const out: Pair[] = [];
  for (const p of json.pairs ?? []) {
    if (!p.pairAddress) continue;
    // The token can be either side of the pair; label the *other* side.
    const isBase = p.baseToken?.address === mint;
    out.push({
      pairAddress: p.pairAddress,
      dex: DEX_NAMES[p.dexId ?? ""] ?? p.dexId ?? "DEX",
      quoteSymbol:
        (isBase ? p.quoteToken?.symbol : p.baseToken?.symbol) ?? "?",
      liquidityUsd: p.liquidity?.usd ?? 0,
      volume24h: p.volume?.h24 ?? 0,
    });
  }
  return out;
}

export async function getPairs(mint: string): Promise<Pair[]> {
  if (cache && cache.mint === mint && Date.now() - cache.at < TTL_MS) {
    return cache.pairs;
  }
  if (inflight) return inflight;

  inflight = fetchPairs(mint)
    .then((pairs) => {
      cache = { at: Date.now(), mint, pairs };
      return pairs;
    })
    .catch((err) => {
      // Serve stale rather than losing pool labelling entirely.
      if (cache && cache.mint === mint) return cache.pairs;
      throw err;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}
