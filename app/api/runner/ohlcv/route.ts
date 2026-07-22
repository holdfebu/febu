import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// GeckoTerminal free tier is ~30 req/min — cache so timeframe flipping can't 429 us.
const TTL = 25_000;
const cache = new Map<string, { t: number; candles: Candle[] }>();

// Roll finer candles up into bigger buckets (no 30m aggregate upstream).
function mergeCandles(list: Candle[], secs: number): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const c of list) {
    const b = Math.floor(c.t / secs) * secs;
    const cur = buckets.get(b);
    if (!cur) buckets.set(b, { ...c, t: b });
    else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
      cur.v += c.v;
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const chain = sp.get("chain");
  const pool = sp.get("pool");
  if (!chain || !pool) return NextResponse.json({ candles: [] });

  const tfReq = Number(sp.get("tf") || "5");
  const tf = [1, 5, 15, 30].includes(tfReq) ? tfReq : 5;
  const src = tf === 30 ? 15 : tf; // upstream only aggregates 1 / 5 / 15

  const key = `${chain}|${pool}|${tf}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) {
    return NextResponse.json({ candles: hit.candles, tf, cached: true });
  }

  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${chain}/pools/${pool}/ohlcv/minute?aggregate=${src}&limit=300&currency=usd`,
      { cache: "no-store", headers: { Accept: "application/json" } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as {
      data?: { attributes?: { ohlcv_list?: number[][] } };
    };
    const list = d.data?.attributes?.ohlcv_list ?? [];
    let candles: Candle[] = list
      .map(([t, o, h, l, c, v]) => ({ t, o: +o, h: +h, l: +l, c: +c, v: +v }))
      .sort((a, b) => a.t - b.t);
    if (tf === 30) candles = mergeCandles(candles, 1800);
    cache.set(key, { t: Date.now(), candles });
    return NextResponse.json({ candles, tf });
  } catch (e) {
    // rate-limited or transient — serve stale rather than an empty chart
    if (hit) return NextResponse.json({ candles: hit.candles, tf, stale: true });
    return NextResponse.json({
      candles: [],
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
