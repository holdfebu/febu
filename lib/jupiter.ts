// Jupiter price feed (Solana). Free "lite" host, no API key required.

export interface TokenPrice {
  mint: string;
  usdPrice: number;
  priceChange24h: number | null;
  liquidity: number | null;
  at: number; // unix ms when fetched
}

export async function getTokenPrice(mint: string): Promise<TokenPrice> {
  const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jupiter price HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
  const json = (await res.json()) as Record<
    string,
    {
      usdPrice?: number;
      priceChange24h?: number;
      liquidity?: number;
    } | null
  >;
  const row = json[mint];
  if (!row || typeof row.usdPrice !== "number") {
    throw new Error("Jupiter returned no price for this mint");
  }
  return {
    mint,
    usdPrice: row.usdPrice,
    priceChange24h: typeof row.priceChange24h === "number" ? row.priceChange24h : null,
    liquidity: typeof row.liquidity === "number" ? row.liquidity : null,
    at: Date.now(),
  };
}
