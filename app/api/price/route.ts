import { NextRequest, NextResponse } from "next/server";
import { getTokenPrice } from "@/lib/jupiter";
import { TOKEN_MINT } from "@/lib/config";

export const dynamic = "force-dynamic";

// Shared across all viewers: clients poll every 10s, so without this a crowd
// would multiply straight through to Jupiter and get rate limited.
const PRICE_TTL_MS = 7_000;
const cache = new Map<string, { at: number; data: Awaited<ReturnType<typeof getTokenPrice>> }>();
const inflight = new Map<string, Promise<Awaited<ReturnType<typeof getTokenPrice>>>>();

async function cachedPrice(mint: string) {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.data;

  const running = inflight.get(mint);
  if (running) return running;

  const task = getTokenPrice(mint)
    .then((data) => {
      cache.set(mint, { at: Date.now(), data });
      return data;
    })
    .finally(() => inflight.delete(mint));
  inflight.set(mint, task);

  try {
    return await task;
  } catch (err) {
    // Serve the last good price rather than flashing an error.
    if (hit) return hit.data;
    throw err;
  }
}

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint") || TOKEN_MINT;
  try {
    const price = await cachedPrice(mint);
    return NextResponse.json(price);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
