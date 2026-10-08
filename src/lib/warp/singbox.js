/**
 * sing-box process management for the WARP tunnel.
 *
 * sing-box provides the WireGuard client. We run it in userspace (no TUN
 * device, no root) with a loopback SOCKS5 inbound, so the gateway can route
 * upstream traffic through the tunnel without touching the system network
 * stack.
 *
 * Binary resolution mirrors the cloudflared/tailscale convention: a copy under
 * DATA_DIR/bin first, then a PATH lookup.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";
import {
  WARP_MTU, WARP_KEEPALIVE_INTERVAL_SEC, WARP_SOCKS_HOST, WARP_SOCKS_PORT,
  WARP_BIN_NAME,
} from "./constants.js";
import { getConfigPath, WARP_DIR } from "./state.js";
import { DATA_DIR } from "@/lib/dataDir.js";

const IS_WINDOWS = os.platform() === "win32";
const BIN_NAME = IS_WINDOWS ? `${WARP_BIN_NAME}.exe` : WARP_BIN_NAME;
const PID_FILE = path.join(WARP_DIR, "sing-box.pid");
const DATA_BIN = path.join(DATA_DIR, "bin", BIN_NAME);

let resolvedBin = undefined; // undefined = not probed yet, null = not found
let proc = null;

/**
 * Find the sing-box binary. Result is cached per process.
 * @returns {string|null} absolute path, or null if unavailable
 */
export function getSingboxBin() {
  if (resolvedBin !== undefined) return resolvedBin;

  if (fs.existsSync(DATA_BIN)) {
    resolvedBin = DATA_BIN;
    return DATA_BIN;
  }

  try {
    const cmd = IS_WINDOWS
      ? `where ${WARP_BIN_NAME} 2>nul`
      : `command -v ${WARP_BIN_NAME} 2>/dev/null || which ${WARP_BIN_NAME} 2>/dev/null`;
    const out = execSync(cmd, {
      stdio: ["ignore", "pipe", "ignore"], timeout: 3000, windowsHide: true,
    }).toString().trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) {
      resolvedBin = out;
      return out;
    }
  } catch { /* not in PATH */ }

  resolvedBin = null;
  return null;
}

export function isSingboxInstalled() {
  return getSingboxBin() !== null;
}

/**
 * Build the sing-box config for a WARP tunnel.
 *
 * Design notes (these matter, they are not incidental):
 *  - DNS is resolved INSIDE the tunnel (detour) so lookups don't leak to the
 *    local resolver. Without this, environments without a working local
 *    resolver fail every lookup with connection refused.
 *  - The SOCKS5 inbound listens on loopback ONLY. Binding 0.0.0.0 would turn
 *    the gateway into an open proxy for anyone on the LAN.
 *  - `system: false` keeps the WireGuard endpoint userspace (no admin/root).
 */
export function buildSingboxConfig(reg, endpoint, socksPort = WARP_SOCKS_PORT) {
  const [host, port] = endpoint.split(":");
  return {
    log: { level: "warn", timestamp: false },
    dns: {
      servers: [
        { type: "udp", tag: "cf", server: "1.1.1.1", server_port: 53, detour: "warp-ep" },
      ],
      final: "cf",
      strategy: "ipv4_only",
    },
    endpoints: [
      {
        type: "wireguard",
        tag: "warp-ep",
        system: false,
        mtu: WARP_MTU,
        address: [`${reg.v4}/32`, `${reg.v6}/128`],
        private_key: reg.privateKey,
        peers: [
          {
            address: host,
            port: Number(port || 2408),
            public_key: reg.peerKey,
            allowed_ips: ["0.0.0.0/0", "::/0"],
            reserved: reg.reserved,
            persistent_keepalive_interval: WARP_KEEPALIVE_INTERVAL_SEC,
          },
        ],
      },
    ],
    inbounds: [
      { type: "socks", tag: "in", listen: WARP_SOCKS_HOST, listen_port: socksPort },
    ],
    route: {
      final: "warp-ep",
      default_domain_resolver: { server: "cf", strategy: "ipv4_only" },
    },
  };
}

/**
 * Validate a config before spawning so a malformed file fails fast, instead
 * of surfacing later as a silent "handshake never completed".
 * @returns {{ok: boolean, error?: string}}
 */
export function checkSingboxConfig(binPath, configPath) {
  try {
    execSync(`"${binPath}" check -c "${configPath}"`, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
      windowsHide: true,
    });
    return { ok: true };
  } catch (e) {
    const stderr = (e.stderr || e.stdout || "").toString("utf8").trim();
    return { ok: false, error: (stderr || e.message).slice(0, 300) };
  }
}

function savePid(pid) {
  try { fs.writeFileSync(PID_FILE, String(pid)); } catch { /* ignore */ }
}

function loadPid() {
  try {
    if (fs.existsSync(PID_FILE)) return parseInt(fs.readFileSync(PID_FILE, "utf8"), 10);
  } catch { /* ignore */ }
  return null;
}

function clearPid() {
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

/**
 * Start sing-box with an already-written config.
 * @returns {boolean} true if the process launched
 */
export function startSingbox(configPath) {
  const bin = getSingboxBin();
  if (!bin) {
    console.warn("[WARP] sing-box not installed; skipping tunnel");
    return false;
  }

  const check = checkSingboxConfig(bin, configPath);
  if (!check.ok) {
    console.warn("[WARP] sing-box rejected config:", check.error);
    return false;
  }

  try {
    proc = spawn(bin, ["run", "-c", configPath], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const child = proc;
    child.on("exit", () => {
      if (proc === child) proc = null;
      clearPid();
    });
    child.on("error", (e) => {
      console.warn("[WARP] sing-box spawn error:", e?.message || e);
      if (proc === child) proc = null;
    });
    savePid(child.pid);
    return true;
  } catch (e) {
    console.warn("[WARP] failed to start sing-box:", e?.message || e);
    proc = null;
    return false;
  }
}

/**
 * Stop sing-box. Safe to call when not running.
 */
export function stopSingbox() {
  const p = proc;
  proc = null;
  if (p && !p.killed) {
    try { p.kill("SIGTERM"); } catch { /* ignore */ }
  }
  const pid = loadPid();
  if (pid) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    clearPid();
  }
}

/**
 * Is the sing-box process alive right now?
 */
export function isSingboxRunning() {
  if (proc && !proc.killed) return true;
  const pid = loadPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}
