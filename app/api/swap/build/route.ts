import { NextRequest, NextResponse } from "next/server";
import {
  FEBU_MINT,
  PLATFORM_FEE_BPS,
  inputTokenByMint,
  JUP_SWAP,
} from "@/lib/swapconfig";

export const dynamic = "force-dynamic";

// Build the swap transaction. The quote is validated to still carry our fee and
// the right mints, then the matching fee account is attached server-side.
export async function POST(req: NextRequest) {
  let body: { quoteResponse?: Record<string, unknown>; userPublicKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const quote = body.quoteResponse;
  const userPublicKey = body.userPublicKey;
  if (!quote || !userPublicKey) {
    return NextResponse.json(
      { error: "quoteResponse and userPublicKey required" },
      { status: 400 }
    );
  }

  // Reject anything that isn't a fee-bearing buy of FEBU with SOL/USDC.
  if (quote.outputMint !== FEBU_MINT) {
    return NextResponse.json({ error: "output must be FEBU" }, { status: 400 });
  }
  const token = inputTokenByMint(String(quote.inputMint));
  if (!token) {
    return NextResponse.json({ error: "input must be SOL or USDC" }, { status: 400 });
  }
  const feeBps = (quote.platformFee as { feeBps?: number } | undefined)?.feeBps;
  if (feeBps !== PLATFORM_FEE_BPS) {
    return NextResponse.json({ error: "quote is missing the platform fee" }, { status: 400 });
  }

  try {
    const res = await fetch(JUP_SWAP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        feeAccount: token.feeAccount,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { priorityLevel: "medium", maxLamports: 4_000_000 } },
      }),
    });
    const json = await res.json();
    if (!res.ok || !json.swapTransaction) {
      return NextResponse.json(
        { error: json.error || `Jupiter swap ${res.status}` },
        { status: 502 }
      );
    }
    return NextResponse.json({
      swapTransaction: json.swapTransaction,
      lastValidBlockHeight: json.lastValidBlockHeight,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "build failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
