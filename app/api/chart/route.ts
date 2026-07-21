import { NextRequest, NextResponse } from "next/server";
import { getCandles, type Timeframe } from "@/lib/geckoterminal";
import { getPairs } from "@/lib/dexscreener";
import { TOKEN_MINT } from "@/lib/config";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Chart ranges, each mapped to a GeckoTerminal timeframe + aggregation.
const RANGES: Record<string, { tf: Timeframe; aggregate: number; limit: number }> = {
  "1H": { tf: "minute", aggregate: 1, limit: 60 },
  "6H": { tf: "minute", aggregate: 5, limit: 72 },
  "24H": { tf: "minute", aggregate: 15, limit: 96 },
  "7D": { tf: "hour", aggregate: 1, limit: 168 },
  "30D": { tf: "hour", aggregate: 4, limit: 180 },
  ALL: { tf: "day", aggregate: 1, limit: 365 },
};

export async function GET(req: NextRequest) {
  const range = (req.nextUrl.searchParams.get("range") || "24H").toUpperCase();
  const cfg = RANGES[range] ?? RANGES["24H"];

  try {
    // Chart the deepest pool — it carries the representative price.
    const pairs = await getPairs(TOKEN_MINT);
    const best = [...pairs].sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
    if (!best) {
      return NextResponse.json({ error: "No pool found" }, { status: 404 });
    }

    const candles = await getCandles(
      best.pairAddress,
      cfg.tf,
      cfg.aggregate,
      cfg.limit
    );

    return NextResponse.json({
      range,
      pool: best.pairAddress,
      dex: best.dex,
      quote: best.quoteSymbol,
      candles,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
