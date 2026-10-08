/**
 * Wire the WARP egress overlay into open-sse's patched fetch layer.
 *
 * open-sse must stay provider-agnostic and not import from src/, so the
 * integration is an injected resolver: open-sse calls this function to ask
 * "what proxy should I use right now?" and the warp manager answers from live
 * tunnel state. When the tunnel is down the resolver returns "" and traffic
 * flows direct exactly as before.
 */
import { getActiveEgressProxyUrl, isWarpEgressSuppressed } from "@/lib/warp/manager.js";
import { setWarpEgressResolver } from "open-sse/utils/proxyFetch.js";

let registered = false;

export function registerWarpEgress() {
  if (registered) return;
  registered = true;
  // WARP's own control plane (registration) suppresses the overlay via
  // withWarpEgressSuppressed(), so a rotation never re-registers through the
  // endpoint it is trying to escape.
  setWarpEgressResolver(() => (isWarpEgressSuppressed() ? "" : getActiveEgressProxyUrl()));
}

export default registerWarpEgress;
