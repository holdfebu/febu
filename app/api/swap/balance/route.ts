import { NextRequest, NextResponse } from "next/server";
import { WSOL_MINT, USDC_MINT } from "@/lib/swapconfig";

export const dynamic = "force-dynamic";

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const rpc = () => `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

async function call(method: string, params: unknown) {
  const res = await fetch(rpc(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

// Spendable SOL and USDC for a wallet, for the swap widget's balance / Max.
export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner");
  if (!owner) return NextResponse.json({ error: "owner required" }, { status: 400 });

  try {
    const [lamports, usdc] = await Promise.all([
      call("getBalance", [owner]).then((r) => r.value as number),
      call("getTokenAccountsByOwner", [
        owner,
        { mint: USDC_MINT },
        { encoding: "jsonParsed" },
      ])
        .then((r) => {
          const acc = r.value?.[0];
          return acc
            ? (acc.account.data.parsed.info.tokenAmount.uiAmount as number)
            : 0;
        })
        .catch(() => 0),
    ]);

    return NextResponse.json({
      SOL: lamports / 1e9,
      USDC: usdc,
      lamports,
      wsolMint: WSOL_MINT,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "balance failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
