import { NextRequest, NextResponse } from "next/server";
import { sendRawTransaction } from "@/lib/helius";

export const dynamic = "force-dynamic";

// Broadcast a wallet-signed transaction via Helius, so the RPC key stays
// server-side. The client only ever signs; it never holds an RPC endpoint.
export async function POST(req: NextRequest) {
  let body: { signedTransaction?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const tx = body.signedTransaction;
  if (!tx || typeof tx !== "string") {
    return NextResponse.json({ error: "signedTransaction required" }, { status: 400 });
  }
  // Guard against oversized junk (a normal swap tx is well under this).
  if (tx.length > 8000) {
    return NextResponse.json({ error: "transaction too large" }, { status: 400 });
  }

  try {
    const signature = await sendRawTransaction(tx);
    return NextResponse.json({ signature });
  } catch (err) {
    const message = err instanceof Error ? err.message : "send failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
