import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { getWarpStatus } from "@/lib/warp/manager.js";

export const dynamic = "force-dynamic";

const STATUS_CACHE_TTL_MS = 3000; // coalesce rapid polling; the handshake probe is the slow part

// Survive hot reload; one cache per process.
const statusCache = (global.__warpStatusCache ??= { value: null, fetchedAt: 0 });

export async function GET() {
  try {
    let value = statusCache.value;
    if (!value || Date.now() - statusCache.fetchedAt >= STATUS_CACHE_TTL_MS) {
      const settings = await getSettings();
      value = {
        ...getWarpStatus(),
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
