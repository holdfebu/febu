import { NextRequest, NextResponse } from "next/server";
import { getTokenBalancesByOwner } from "@/lib/helius";
import { getTokenPrices } from "@/lib/jupiter";
import { TOKEN_MINT } from "@/lib/config";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Common pair tokens, so the breakdown reads in symbols rather than mints.
const KNOWN: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
};

interface Entry {
  mint: string;
  symbol: string;
  amount: number;
  usd: number | null;
}

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; data: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

async function build(owner: string) {
  const balances = await getTokenBalancesByOwner(owner);
  const prices = await getTokenPrices(balances.map((b) => b.mint)).catch(
    () => new Map<string, number>()
  );

  const entries: Entry[] = balances
    .map((b) => {
      const price = prices.get(b.mint);
      return {
        mint: b.mint,
        symbol:
          b.mint === TOKEN_MINT
            ? "FEBU"
            : KNOWN[b.mint] || `${b.mint.slice(0, 4)}…${b.mint.slice(-4)}`,
        amount: b.amount,
        usd: price != null ? b.amount * price : null,
      };
    })
    // Pool addresses collect spam airdrops; drop anything negligible.
    .filter((e) => (e.usd ?? 0) >= 1)
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));

  const tvl = entries.reduce((s, e) => s + (e.usd ?? 0), 0);
  return { owner, entries, tvl, at: Date.now() };
}

export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner");
  if (!owner) {
    return NextResponse.json({ error: "Provide ?owner=" }, { status: 400 });
  }

  const hit = cache.get(owner);
  if (hit && Date.now() - hit.at < TTL_MS) return NextResponse.json(hit.data);

  const running = inflight.get(owner);
  if (running) return NextResponse.json(await running);

  const task = build(owner)
    .then((data) => {
      cache.set(owner, { at: Date.now(), data });
      return data;
    })
    .finally(() => inflight.delete(owner));
  inflight.set(owner, task);

  try {
    return NextResponse.json(await task);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
