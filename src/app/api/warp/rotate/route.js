import { NextResponse } from "next/server";
import { rotateWarp, getWarpStatus } from "@/lib/warp/manager.js";

export const dynamic = "force-dynamic";

// A rotation tries up to MAX_ROTATE_ATTEMPTS endpoints, each with its own
// handshake window, so this can legitimately take a while.
export const maxDuration = 90;

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const reason = typeof body?.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 100)
      : "panel manual";

    const result = await rotateWarp(reason);
    if (!result.ok && result.busy) {
      // A rotation is already in flight (the queue serializes them). Tell the
      // UI instead of making it wait on a lock it cannot observe.
      return NextResponse.json({ ok: false, busy: true, ...getWarpStatus() }, { status: 409 });
    }
    if (!result.ok) {
      return NextResponse.json({ error: result.error || "Rotation failed" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, attempts: result.attempts, ...getWarpStatus() });
  } catch (error) {
    console.error("[WARP] rotate error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
