import { NextResponse } from "next/server";
import { enableWarp, getWarpStatus } from "@/lib/warp/manager.js";
import { updateSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// Bringing the tunnel up is a network round-trip (registration + WireGuard
// handshake), so give it generous headroom; the panel shows a spinner.
export const maxDuration = 60;

export async function POST() {
  try {
    const result = await enableWarp();
    if (!result.ok) {
      return NextResponse.json({ error: result.error || "Failed to enable WARP" }, { status: 502 });
    }
    // Persist the intent so the watchdog auto-resumes after a restart. The
    // manager already writes this, but a settings update keeps the dashboard
    // cache coherent without a refetch.
    await updateSettings({ warpEnabled: true }).catch(() => {});
    return NextResponse.json({ ok: true, ...getWarpStatus() });
  } catch (error) {
    console.error("[WARP] enable error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
