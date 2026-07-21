import { NextResponse } from "next/server";
import { stats } from "@/lib/presence";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(stats());
}
