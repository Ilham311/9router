/**
 * Persistent WARP state.
 *
 * Holds the registered device params so the tunnel can be rebuilt after a
 * restart WITHOUT re-registering (each registration is a fresh identity, and
 * hammering the registration API is both unnecessary and rate-limited).
 *
 * SECURITY: state.json contains the WireGuard private key. It is written with
 * 0600 permissions and must never be echoed into the status API response.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

export const WARP_DIR = path.join(DATA_DIR, "warp");
const STATE_FILE = path.join(WARP_DIR, "state.json");
const CONFIG_FILE = path.join(WARP_DIR, "sing-box.json");

export function ensureWarpDir() {
  if (!fs.existsSync(WARP_DIR)) fs.mkdirSync(WARP_DIR, { recursive: true });
}

export function loadWarpState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch { /* ignore corrupt state */ }
  return null;
}

/**
 * Write state with restrictive permissions. The private key lives here.
 * Returns the merged state.
 */
export function saveWarpState(state) {
  ensureWarpDir();
  let fd;
  try {
    fd = fs.openSync(STATE_FILE, "w", 0o600);
    fs.writeSync(fd, JSON.stringify(state, null, 2));
    // openSync("w") only applies the mode to files it CREATES — a state file
    // left over from an older build (or a read by a tool that reset its mode)
    // keeps its old permissions. chmod so an existing file is tightened too.
    fs.chmodSync(STATE_FILE, 0o600);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return state;
}

export function clearWarpState() {
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch { /* ignore */ }
}

export function getConfigPath() {
  ensureWarpDir();
  return CONFIG_FILE;
}

export { STATE_FILE, CONFIG_FILE };
