import { NextRequest, NextResponse } from "next/server";
import { resolveEarliest, mapLimit } from "@/lib/holdtime";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const single = sp.get("account");
  const many = sp.get("accounts");

  try {
    if (many) {
      const accounts = many
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 40);
      const times = await mapLimit(accounts, 3, resolveEarliest);
      const now = Math.floor(Date.now() / 1000);
      const out: Record<
        string,
        { firstBlockTime: number | null; ageSeconds: number | null }
      > = {};
      accounts.forEach((a, i) => {
        const t = times[i];
        out[a] = {
          firstBlockTime: t,
          ageSeconds: t != null ? now - t : null,
        };
      });
      return NextResponse.json({ results: out });
    }

    if (single) {
      const t = await resolveEarliest(single);
      const now = Math.floor(Date.now() / 1000);
      return NextResponse.json({
        account: single,
        firstBlockTime: t,
        ageSeconds: t != null ? now - t : null,
      });
    }

    return NextResponse.json(
      { error: "Provide ?account= or ?accounts=" },
      { status: 400 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
