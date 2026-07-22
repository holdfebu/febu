import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface DsPair {
  baseToken?: { name?: string; symbol?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: unknown;
  priceChange?: unknown;
  txns?: unknown;
  pairCreatedAt?: number;
  dexId?: string;
  url?: string;
  pairAddress?: string;
}

// Full on-demand metrics for one token (the click-to-expand panel).
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const chain = sp.get("chain");
  const addr = sp.get("addr");
  if (!chain || !addr) {
    return NextResponse.json(
      { error: "chain and addr required" },
      { status: 400 }
    );
  }

  const out: Record<string, unknown> = { chain, addr };
  try {
    const res = await fetch(
      `https://api.dexscreener.com/tokens/v1/${chain}/${addr}`,
      { cache: "no-store", headers: { Accept: "application/json" } }
    );
    const list = (await res.json()) as DsPair[];
    const pairs = Array.isArray(list) ? list : [];
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const p = pairs[0];
    if (p) {
      out.name = p.baseToken?.name;
      out.symbol = p.baseToken?.symbol;
      out.priceUsd = p.priceUsd ?? null;
      out.marketCap = p.marketCap ?? p.fdv ?? null;
      out.fdv = p.fdv ?? null;
      out.liquidity = p.liquidity?.usd ?? null;
      out.volume = p.volume || {};
      out.priceChange = p.priceChange || {};
      out.txns = p.txns || {};
      out.pairCreatedAt = p.pairCreatedAt ?? null;
      out.dexId = p.dexId ?? null;
      out.url = p.url ?? null;
      out.pairAddress = p.pairAddress ?? null;
    }
  } catch {
    /* leave blank */
  }

  if (chain === "solana" && addr.endsWith("pump")) {
    try {
      const res = await fetch(
        `https://frontend-api-v3.pump.fun/coins/${addr}`,
        { cache: "no-store", headers: { Accept: "application/json" } }
      );
      const c = (await res.json()) as {
        creator?: string;
        ath_market_cap?: number;
      };
      out.creator = c.creator || null;
      out.athMarketCap = c.ath_market_cap ?? null;
    } catch {
      /* optional */
    }
  }

  return NextResponse.json(out);
}
