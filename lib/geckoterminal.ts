/**
 * OHLCV candles from GeckoTerminal (CoinGecko's DEX data). Free, no API key.
 * DexScreener has no public candles endpoint, and a pump.fun token won't be
 * listed on CoinGecko proper, so this is the workable source.
 */

export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = "minute" | "hour" | "day";

interface Entry {
  at: number;
  candles: Candle[];
}

// Candles only close once per interval, so cache generously.
const TTL: Record<Timeframe, number> = {
  minute: 30_000,
  hour: 120_000,
  day: 600_000,
};

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Candle[]>>();

async function fetchCandles(
  pool: string,
  tf: Timeframe,
  aggregate: number,
  limit: number
): Promise<Candle[]> {
  const url =
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}` +
    `/ohlcv/${tf}?aggregate=${aggregate}&limit=${limit}`;

  const res = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`);

  const json = (await res.json()) as {
    data?: { attributes?: { ohlcv_list?: number[][] } };
  };
  const list = json.data?.attributes?.ohlcv_list ?? [];

  // API returns newest-first; charts want oldest-first.
  return list
    .map((c) => ({
      time: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5],
    }))
    .sort((a, b) => a.time - b.time);
}

export async function getCandles(
  pool: string,
  tf: Timeframe,
  aggregate = 1,
  limit = 300
): Promise<Candle[]> {
  const key = `${pool}:${tf}:${aggregate}:${limit}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL[tf]) return hit.candles;

  const running = inflight.get(key);
  if (running) return running;

  const task = fetchCandles(pool, tf, aggregate, limit)
    .then((candles) => {
      cache.set(key, { at: Date.now(), candles });
      return candles;
    })
    .catch((err) => {
      if (hit) return hit.candles; // serve stale rather than an empty chart
      throw err;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}
