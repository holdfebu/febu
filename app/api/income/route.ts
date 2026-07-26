import { NextResponse } from "next/server";
import { getIncome } from "@/lib/income";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getIncome();
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
