/**
 * Cloudflare WARP egress manager.
 *
 *   enableWarp()              build the tunnel (once)
 *   rotateWarp(reason)        switch endpoint/device, wait for a new egress
 *   ensureWarpUp()            self-heal if the process died
 *   getWarpStatus()           state for the UI + API
 *
 * Why this module exists: the gateway can have many upstream accounts, and
 * some providers rate-limit per egress IP rather than per key. When every
 * account in one colo is 429'd, rotating the WARP endpoint changes the IP the
 * provider sees — recovering without paying for a proxy pool.
 *
 * What WARP deliberately cannot do (validated, not assumed):
 *  - pick a country freely; the colo follows the endpoint, not GeoIP
 *  - defeat provider WAFs
 *  - unlimited IPv4 rotation (~one /24 per colo)
 *
 * Fail-open policy: if the tunnel cannot come up, upstream traffic continues
 * direct. WARP is an optimization, never a hard dependency.
 */
import fs from "node:fs";
import {
  WARP_ENDPOINTS, HANDSHAKE_MS, PROBE_SPACING_MS, STOP_TIMEOUT_MS,
  MAX_ROTATE_ATTEMPTS, WARP_PEER_KEY, WARP_SOCKS_HOST, WARP_SOCKS_PORT,
} from "./constants.js";
import {
  loadWarpState, saveWarpState, clearWarpState, getConfigPath,
} from "./state.js";
import {
  getSingboxBin, buildSingboxConfig, startSingbox, stopSingbox, isSingboxRunning,
} from "./singbox.js";
import { registerWarpDevice } from "./register.js";
import { probeWarpEgress, warpSocksUrl } from "./probe.js";
import { getSettings, updateSettings } from "@/lib/localDb.js";

const log = (...args) => console.log(`${new Date().toISOString().slice(11, 23)} [WARP]`, ...args);

// One in-flight operation at a time: a rotation holds a lock, and the panel
// rotate button must not stack a second rotation behind a running one.
let operationQueue = Promise.resolve();
let inTunnelOp = false;

// Single-flight sweep rotation. Many concurrent 429 sweeps (one per in-flight
// request) must collapse onto ONE rotation — otherwise N requests each stop
// and rebuild the tunnel, which both wastes time and drops every other
// in-flight request through the churn.
let sweepRotation = null; // { promise, startedAt }

// WARP's own control-plane calls (registration, probes) must not be routed
// back through the WARP egress: during a rotation the old tunnel may be the
// saturated endpoint we are trying to escape, and re-registering through it
// would just fail. See withWarpEgressSuppressed().
let suppressDepth = 0;

/**
 * Run a callback with the WARP egress overlay disabled for THIS process.
 * Used only by WARP's own control plane.
 */
export async function withWarpEgressSuppressed(fn) {
  suppressDepth++;
  try {
    return await fn();
  } finally {
    suppressDepth--;
  }
}

export function isWarpEgressSuppressed() {
  return suppressDepth > 0;
}

function serialize(fn) {
  const run = operationQueue.then(fn, fn);
  operationQueue = run.catch(() => {});
  return run;
}

// Current tunnel record. Persisted so a restart reuses the same device instead
// of registering a fresh one (registration is rate-limited and unnecessary).
let tunnel = null;

function persistTunnel() {
  if (!tunnel) return;
  saveWarpState({
    endpoint: tunnel.endpoint,
    privateKey: tunnel.privateKey,
    publicKey: tunnel.publicKey,
    v4: tunnel.v4,
    v6: tunnel.v6,
    reserved: tunnel.reserved,
    clientId: tunnel.clientId,
    license: tunnel.license,
    peerKey: tunnel.peerKey,
    colo: tunnel.colo,
    ip: tunnel.ip,
    failedEndpoints: tunnel.failedEndpoints || [],
  });
}

function restoreTunnel() {
  if (tunnel) return true;
  const saved = loadWarpState();
  if (!saved || !saved.privateKey || !saved.v4 || !saved.v6) return false;
  tunnel = {
    endpoint: saved.endpoint || "",
    privateKey: saved.privateKey,
    publicKey: saved.publicKey || "",
    v4: saved.v4,
    v6: saved.v6,
    reserved: Array.isArray(saved.reserved) ? saved.reserved : [],
    clientId: saved.clientId || "",
    license: saved.license || "",
    peerKey: saved.peerKey || WARP_PEER_KEY,
    colo: saved.colo || "",
    ip: saved.ip || "",
    failedEndpoints: Array.isArray(saved.failedEndpoints) ? saved.failedEndpoints : [],
  };
  return true;
}

function registrationFromTunnel() {
  if (!tunnel) return null;
  return {
    privateKey: tunnel.privateKey,
    publicKey: tunnel.publicKey,
    v4: tunnel.v4,
    v6: tunnel.v6,
    reserved: tunnel.reserved,
    clientId: tunnel.clientId,
    license: tunnel.license,
    peerKey: tunnel.peerKey,
  };
}

function pickNextEndpoint(exclude) {
  // Rotate to a DIFFERENT endpoint — re-dialing the same colo does nothing.
  const skip = new Set([...(exclude ? [exclude] : []), ...(tunnel?.failedEndpoints || [])]);
  for (const cand of WARP_ENDPOINTS) {
    if (!skip.has(cand.endpoint)) return cand;
  }
  // Everything is marked failed; start over with a fresh candidate.
  return WARP_ENDPOINTS.find((c) => c.endpoint !== exclude) || WARP_ENDPOINTS[0];
}

function writeConfig(reg, endpoint, socksPort) {
  // The config embeds the WireGuard private_key, so it must not be
  // world-readable — writeFileSync alone would leave it at 0644.
  const configPath = getConfigPath();
  let fd;
  try {
    fd = fs.openSync(configPath, "w", 0o600);
    fs.writeSync(fd, JSON.stringify(buildSingboxConfig(reg, endpoint, socksPort), null, 2));
    // openSync("w") only sets the mode on files it creates; tighten an
    // existing config file too.
    fs.chmodSync(configPath, 0o600);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return configPath;
}

/**
 * Bring the tunnel up (or rebuild it on a new endpoint).
 *
 * @param {object} opts
 * @param {string} opts.reason - for logging only
 * @param {boolean} opts.rotateEndpoint - true = move to a different colo
 * @param {boolean} opts.rotateDevice - true = re-register a fresh identity
 * @param {number} opts.socksPort
 * @returns {Promise<boolean>} true once the egress responds
 */
async function bringUp({ reason, rotateEndpoint, rotateDevice, socksPort }) {
  const t0 = Date.now();
  const prevColo = tunnel?.colo || "";

  let endpoint = "";
  if (tunnel && !rotateEndpoint) {
    endpoint = tunnel.endpoint;
  }
  if (!endpoint) {
    const next = pickNextEndpoint(tunnel?.endpoint || null);
    endpoint = next.endpoint;
    log(`rotating endpoint -> ${endpoint} (${next.colo})`);
  }

  // A different endpoint can reuse the existing device; a fresh identity needs
  // a new registration.
  let reg = null;
  if (!tunnel || rotateDevice) {
    // Register OUTSIDE the egress overlay: during a rotation the current
    // tunnel may be the endpoint we are escaping, and re-registering through
    // it would fail for the same reason the requests did.
    reg = await withWarpEgressSuppressed(() => registerWarpDevice());
  }
  if (!reg) {
    if (!tunnel) {
      log(`initial registration failed; tunnel down (${reason})`);
      return false;
    }
    reg = registrationFromTunnel();
  }

  stopSingbox();

  const configPath = writeConfig(reg, endpoint, socksPort);
  if (!startSingbox(configPath)) return false;

  // Wait for the handshake: poll the egress until it answers, bounded by an
  // absolute deadline. A dead endpoint surfaces after HANDSHAKE_MS instead of
  // stacking N x probe-timeout.
  const deadline = Date.now() + HANDSHAKE_MS;
  while (true) {
    const { ip, colo } = await probeWarpEgress(socksPort);
    if (ip) {
      const previous = tunnel;
      tunnel = {
        ...reg,
        endpoint,
        colo,
        ip,
        failedEndpoints: (previous?.failedEndpoints || []).filter((e) => e !== endpoint),
      };
      persistTunnel();
      const via = prevColo && colo !== prevColo ? ` (was ${prevColo})` : "";
      log(`up via ${endpoint} -> ip=${ip} colo=${colo}${via} (${reason}, ${(Date.now() - t0) / 1000}s)`);
      return true;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, PROBE_SPACING_MS));
  }

  // This endpoint is unreachable from this network. Remember it so the next
  // rotation skips it, and report failure so the caller tries another.
  log(`handshake never completed via ${endpoint} (${reason}, ${(Date.now() - t0) / 1000}s)`);
  if (tunnel) {
    tunnel.failedEndpoints = [...new Set([...(tunnel.failedEndpoints || []), endpoint])];
    persistTunnel();
  }
  stopSingbox();
  return false;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Enable WARP. Idempotent — re-running while up is a no-op.
 * Persists `warpEnabled` so the watchdog auto-resumes after a restart.
 */
export async function enableWarp(socksPort = WARP_SOCKS_PORT) {
  return serialize(async () => {
    inTunnelOp = true;
    try {
      if (!getSingboxBin()) {
        return { ok: false, error: "sing-box is not installed. Install it and try again." };
      }
      if (isSingboxRunning() && tunnel?.ip) {
        return { ok: true, alreadyRunning: true };
      }
      restoreTunnel();
      const ok = await bringUp({
        reason: "enable",
        rotateEndpoint: false,
        rotateDevice: false,
        socksPort,
      });
      await updateSettings({ warpEnabled: ok });
      return { ok, error: ok ? undefined : "Handshake did not complete on any endpoint" };
    } finally {
      inTunnelOp = false;
    }
  });
}

/**
 * Disable WARP and stop routing upstream traffic through it.
 */
export async function disableWarp() {
  return serialize(async () => {
    inTunnelOp = true;
    try {
      stopSingbox();
      tunnel = null;
      clearWarpState();
      await updateSettings({ warpEnabled: false });
      log("disabled");
      return { ok: true };
    } finally {
      inTunnelOp = false;
    }
  });
}

/**
 * Rotate to a different egress: different endpoint first (new colo), fresh
 * device identity if the first attempt fails.
 *
 * Called by the 429 sweep when every account in this colo is saturated, and
 * by the panel's manual rotate button.
 *
 * @returns {Promise<{ok: boolean, busy?: boolean}>}
 */
export async function rotateWarp(reason = "manual") {
  return serialize(async () => {
    if (!getSingboxBin()) return { ok: false, error: "sing-box is not installed" };
    if (inTunnelOp) return { ok: false, busy: true };

    inTunnelOp = true;
    try {
      restoreTunnel();
      for (let attempt = 1; attempt <= MAX_ROTATE_ATTEMPTS; attempt++) {
        // New endpoint (colo) first; only re-register a fresh device if that
        // still doesn't come up — a new identity is a heavier hammer.
        const ok = await bringUp({
          reason: `${reason} #${attempt}`,
          rotateEndpoint: true,
          rotateDevice: attempt > 1,
          socksPort: WARP_SOCKS_PORT,
        });
        if (ok) return { ok: true, attempts: attempt };
      }
      return { ok: false, error: `failed after ${MAX_ROTATE_ATTEMPTS} attempts` };
    } finally {
      inTunnelOp = false;
    }
  });
}

/**
 * Start (or join) the sweep rotation.
 *
 * Every concurrent 429 sweep receives the SAME in-flight promise, so N
 * requests trigger exactly one tunnel rotation. The caller decides how long
 * to await it (see chat.js: bounded wait, then Retry-After) — this function
 * never blocks longer than the caller's own deadline.
 *
 * @returns {Promise<{ok: boolean, busy?: boolean, timeout?: boolean}>}
 */
export function startSweepRotation(reason = "429 sweep") {
  if (!sweepRotation) {
    const startedAt = Date.now();
    const promise = (async () => {
      try {
        return await rotateWarp(reason);
      } finally {
        // Clear only if still ours: a caller may have replaced us already.
        if (sweepRotation?.promise === promise) sweepRotation = null;
      }
    })();
    sweepRotation = { promise, startedAt };
  }
  return sweepRotation.promise;
}

/**
 * Is a sweep rotation running right now, and when did it start? Lets callers
 * decide between "join and wait" and "answer now with Retry-After".
 */
export function getSweepRotationState() {
  if (!sweepRotation) return null;
  return { startedAt: sweepRotation.startedAt, elapsedMs: Date.now() - sweepRotation.startedAt };
}

/**
 * Self-heal: restart the tunnel on the same endpoint if the process died
 * (mobile/low-memory killers reap background processes). This is
 * availability, NOT rotation.
 */
export async function ensureWarpUp() {
  const settings = await getSettings();
  if (!settings.warpEnabled) return false;
  return serialize(async () => {
    if (isSingboxRunning()) return true;
    log("process gone; restarting on same endpoint");
    restoreTunnel();
    return bringUp({
      reason: "self-heal",
      rotateEndpoint: false,
      rotateDevice: false,
      socksPort: WARP_SOCKS_PORT,
    });
  });
}

/**
 * Status for the UI and API. Never includes the private key.
 */
export function getWarpStatus() {
  const installed = getSingboxBin() !== null;
  const running = isSingboxRunning();
  return {
    installed,
    enabled: tunnel !== null && running,
    running,
    busy: inTunnelOp,
    endpoint: tunnel?.endpoint || "",
    colo: tunnel?.colo || "",
    ip: tunnel?.ip || "",
    socks: running ? warpSocksUrl(WARP_SOCKS_PORT) : "",
    socksHost: WARP_SOCKS_HOST,
    socksPort: WARP_SOCKS_PORT,
  };
}

/**
 * The SOCKS5 URL upstream requests should use, or "" when the tunnel is not
 * actually up. Consumed by the proxy layer (see proxyFetch integration).
 */
export function getActiveEgressProxyUrl() {
  if (!tunnel || !isSingboxRunning()) return "";
  return warpSocksUrl(WARP_SOCKS_PORT);
}
