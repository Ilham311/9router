import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { getWarpStatus } from "@/lib/warp/manager.js";
import { isLocalRequest, hasValidCliToken, isAuthenticated } from "@/dashboardGuard.js";

export const dynamic = "force-dynamic";

const STATUS_CACHE_TTL_MS = 3000; // coalesce rapid polling; the handshake probe is the slow part

// Survive hot reload; one cache per process.
const statusCache = (global.__warpStatusCache ??= { value: null, fetchedAt: 0 });

export async function GET(request) {
  try {
    let value = statusCache.value;
    if (!value || Date.now() - statusCache.fetchedAt >= STATUS_CACHE_TTL_MS) {
      const settings = await getSettings();
      // Enable/disable/rotate are local-only routes (they spawn processes and
      // change the gateway's egress). Tell the panel up front so it greys them
      // out instead of answering a click with a 403.
      const canControl = await hasValidCliToken(request)
        || (isLocalRequest(request) && await isAuthenticated(request));
      value = {
        ...getWarpStatus(),
        canControl,
        // WARP is default-on for installs with no stored preference. The panel
        // uses this to show "connecting…" instead of "off" on a fresh boot.
        defaultOn: settings.warpEnabled === undefined,
        // Settings-backed preferences (the toggle itself is also persisted
        // here so the panel reflects state even before the tunnel answers).
        autoRotate: settings.warpAutoRotate !== false,
      };
      statusCache.value = value;
      statusCache.fetchedAt = Date.now();
    }
    return NextResponse.json(value);
  } catch (error) {
    console.error("[WARP] status error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
