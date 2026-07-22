import { NextRequest, NextResponse } from "next/server";
import { getSignatureStatus } from "@/lib/helius";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sig = req.nextUrl.searchParams.get("sig");
  if (!sig) {
    return NextResponse.json({ error: "sig required" }, { status: 400 });
  }
  try {
    const status = await getSignatureStatus(sig);
    return NextResponse.json({
      confirmationStatus: status?.confirmationStatus ?? null,
      err: status?.err ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "status failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
