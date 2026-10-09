import { NextResponse } from "next/server";
import { disableWarp, getWarpStatus } from "@/lib/warp/manager.js";
import { updateSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await disableWarp();
    // Mirror enableWarp: the routes own `warpEnabled` persistence.
    await updateSettings({ warpEnabled: false }).catch(() => {});
    return NextResponse.json({ ok: true, ...getWarpStatus() });
  } catch (error) {
    console.error("[WARP] disable error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
