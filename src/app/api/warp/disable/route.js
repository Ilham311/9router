import { NextResponse } from "next/server";
import { disableWarp, getWarpStatus } from "@/lib/warp/manager.js";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await disableWarp();
    return NextResponse.json({ ok: true, ...getWarpStatus() });
  } catch (error) {
    console.error("[WARP] disable error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
