/**
 * Cloudflare WARP constants.
 *
 * WARP is a free WireGuard tunnel offered by Cloudflare. Every anycast
 * endpoint egresses from a different colo, so rotating the endpoint changes
 * the egress IP the upstream providers see — without paying for proxy pools.
 *
 * Honest limitations (validated against the reference implementation):
 *  - you cannot pick a country; the colo follows the endpoint, not GeoIP
 *  - it will not fool provider WAFs (Amazon still 403s through WARP)
 *  - IPv4 rotation is not infinite — roughly one /24 per colo
 */

// Peer public key is stable across all endpoints and registrations; it is only
// used when re-using an existing device without re-registering.
export const WARP_PEER_KEY = "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=";

// WARP device registration API (same version the official client uses).
export const WARP_REG_URL = "https://api.cloudflareclient.com/v0a2158/reg";
export const WARP_REG_USER_AGENT = "okhttp/3.12.1";

// Egress identity probe: returns `ip=` / `colo=` lines when fetched THROUGH
// the tunnel, which is how we confirm the handshake completed.
export const WARP_TRACE_URL = "https://api.cloudflare.com/cdn-cgi/trace";

// SOCKS5 inbound exposed by sing-box on loopback. Loopback-only on purpose:
// binding 0.0.0.0 would turn the gateway into an open proxy for the LAN.
export const WARP_SOCKS_HOST = "127.0.0.1";
export const WARP_SOCKS_PORT = 10808;

// Anycast endpoint pool (WireGuard UDP 2408; IPsec/NAT ports are fallbacks for
// networks that block 2408). Colos are annotated for the UI.
export const WARP_ENDPOINTS = [
  { endpoint: "162.159.192.1:2408", colo: "US-West anycast" },
  { endpoint: "162.159.193.1:2408", colo: "US anycast" },
  { endpoint: "162.159.195.1:2408", colo: "US anycast" },
  { endpoint: "162.159.192.10:2408", colo: "LAX" },
  { endpoint: "162.159.192.2:2408", colo: "SJC" },
  { endpoint: "162.159.193.2:2408", colo: "SEA" },
  { endpoint: "188.114.96.1:2408", colo: "EU backbone" },
  { endpoint: "188.114.97.1:2408", colo: "EU backbone" },
  { endpoint: "188.114.98.1:2408", colo: "EU backbone" },
  { endpoint: "188.114.99.1:2408", colo: "EU backbone" },
  { endpoint: "162.159.192.9:2408", colo: "Asia direct" },
  { endpoint: "162.159.193.9:2408", colo: "Asia direct" },
  { endpoint: "162.159.195.9:2408", colo: "Asia direct" },
  { endpoint: "8.47.69.50:2408", colo: "CGK (Jakarta)" },
  { endpoint: "8.47.69.48:878", colo: "CGK alt port" },
  { endpoint: "162.159.192.1:500", colo: "US IPsec port" },
  { endpoint: "162.159.193.1:4500", colo: "US NAT-T port" },
  { endpoint: "162.159.195.1:1701", colo: "US L2TP port" },
];

// Time budgets (ms). A healthy WireGuard handshake completes in ~3-6s, so the
// handshake window is generous; anything slower means the endpoint is simply
// unreachable from this network and waiting only stacks latency.
export const HANDSHAKE_MS = 15000;
export const PROBE_TIMEOUT_MS = 8000;
export const PROBE_SPACING_MS = 700;
export const STOP_TIMEOUT_MS = 8000;
export const MAX_ROTATE_ATTEMPTS = 3;

// Self-heal cadence for the watchdog; a rotation is availability, not a retry.
export const WARP_KEEPALIVE_INTERVAL_MS = 60000;

// How often a 429 sweep may trigger an automatic rotation. Rate limits are
// per egress IP, so rotating faster than this just churns the tunnel without
// unlocking anything new.
export const AUTO_ROTATE_MIN_INTERVAL_MS = 30000;

// A 429 sweep waits at most this long for the rotation before answering the
// client. Most SDKs (openai-node, anthropic SDK) honor `Retry-After`, so when
// the rotation is slow the client simply lands on the new egress on its next
// attempt instead of us holding the connection open past proxy timeouts.
// Realistic rotation: 3-6s (register + handshake). Worst case (every endpoint
// dead): MAX_ROTATE_ATTEMPTS x HANDSHAKE_MS = 45s, which we deliberately do NOT
// make the client wait for.
export const WARP_ROTATE_WAIT_MS = 10_000;

// Retry-After we send when a rotation is still in flight. Generous enough to
// cover a healthy rotation plus a second attempt, short enough that the client
// recovers promptly.
export const WARP_ROTATE_RETRY_AFTER_MS = 15_000;

// WireGuard MTU inside the tunnel (WARP's recommended value).
export const WARP_MTU = 1280;
export const WARP_KEEPALIVE_INTERVAL_SEC = 30;

export const WARP_BIN_NAME = "sing-box";
