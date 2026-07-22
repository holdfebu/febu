import { NextRequest, NextResponse } from "next/server";
import {
  FEBU_MINT,
  INPUT_TOKENS,
  PLATFORM_FEE_BPS,
  JUP_QUOTE,
} from "@/lib/swapconfig";

export const dynamic = "force-dynamic";

// Buy FEBU with SOL or USDC. The platform fee is injected here, server-side,
// so it can't be stripped by editing the client request.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const inputKey = sp.get("input"); // "SOL" | "USDC"
  const amount = sp.get("amount"); // raw integer (already * decimals)
  const slippageBps = sp.get("slippageBps") || "50";

  const token = inputKey === "SOL" || inputKey === "USDC" ? INPUT_TOKENS[inputKey] : null;
  if (!token) {
    return NextResponse.json({ error: "input must be SOL or USDC" }, { status: 400 });
  }
  if (!amount || !/^\d+$/.test(amount) || amount === "0") {
    return NextResponse.json({ error: "invalid amount" }, { status: 400 });
  }

  const url =
    `${JUP_QUOTE}?inputMint=${token.mint}&outputMint=${FEBU_MINT}` +
    `&amount=${amount}&slippageBps=${Number(slippageBps)}` +
    `&platformFeeBps=${PLATFORM_FEE_BPS}&restrictIntermediateTokens=true`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    const json = await res.json();
    if (!res.ok) {
      return NextResponse.json(
        { error: json.error || `Jupiter ${res.status}` },
        { status: 502 }
      );
    }
    return NextResponse.json(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : "quote failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
