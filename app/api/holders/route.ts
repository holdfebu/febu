import { NextRequest, NextResponse } from "next/server";
import { computeHolders } from "@/lib/holders";
import {
  getBaseline,
  maybeCapture,
  recordRanks,
  movementFor,
  rankWindowSeconds,
} from "@/lib/history";
import { TOKEN_MINT } from "@/lib/config";
import { maybeRefreshFlows, getFlow, flowsAgeSeconds } from "@/lib/flows";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint") || TOKEN_MINT;
  const limit = Number(req.nextUrl.searchParams.get("limit") || "500");
  const force = req.nextUrl.searchParams.get("fresh") === "1";

  try {
    const data = await computeHolders(mint, Math.min(Math.max(limit, 1), 2000), force);

    // Record history in the background — never block the response.
    // Re-read at full depth (a cache hit): `data` is trimmed to the caller's
    // ?limit=, and snapshotting that would record a partial baseline.
    void computeHolders(mint, 250)
      .then((full) => {
        recordRanks(full.holders);
        void maybeRefreshFlows(full.holders);
        return maybeCapture(full);
      })
      .catch(() => {});

    // Attach per-wallet movement versus the ~24h baseline.
    const holders = data.holders.map((h) => {
      const flow = getFlow(h.owner);
      return {
        ...h,
        ...movementFor(h.owner, h.rank, h.amount),
        bought: flow ? flow.bought : null,
        sold: flow ? flow.sold : null,
        flowReconciled: flow ? flow.reconciled : false,
      };
    });

    return NextResponse.json({
      ...data,
      holders,
      baseline: getBaseline(),
      rankWindowSeconds: rankWindowSeconds(),
      flowsAgeSeconds: flowsAgeSeconds(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
