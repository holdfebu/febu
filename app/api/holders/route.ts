import { NextRequest, NextResponse } from "next/server";
import { computeHolders } from "@/lib/holders";
import { getBaseline, maybeCapture } from "@/lib/history";
import { TOKEN_MINT } from "@/lib/config";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint") || TOKEN_MINT;
  const limit = Number(req.nextUrl.searchParams.get("limit") || "500");
  const force = req.nextUrl.searchParams.get("fresh") === "1";

  try {
    const data = await computeHolders(mint, Math.min(Math.max(limit, 1), 2000), force);

    // Record history in the background — never block the response.
    void maybeCapture(data);

    return NextResponse.json({ ...data, baseline: getBaseline() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
