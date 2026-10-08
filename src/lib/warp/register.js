/**
 * Cloudflare WARP device registration.
 *
 * Each registration = a fresh Curve25519 keypair + a fresh v6 /128, so this is
 * how you get a *fresh tunnel identity*, not just a different colo.
 *
 * Keypairs are generated with Node's built-in X25519 support (WireGuard uses
 * Curve25519) instead of shelling out to `sing-box generate wg-keypair` — one
 * less dependency on the binary being installed just to register.
 */
import crypto from "node:crypto";
import { WARP_REG_URL, WARP_REG_USER_AGENT, WARP_PEER_KEY } from "./constants.js";

function b64uToB64(value) {
  return Buffer.from(value, "base64url").toString("base64");
}

/**
 * Generate a fresh WireGuard (X25519) keypair.
 * Returns { privateKey, publicKey } as unpadded base64 (sing-box format).
 */
export function generateWgKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const pubJwk = publicKey.export({ format: "jwk" });
  const privJwk = privateKey.export({ format: "jwk" });
  // JWK stores the raw 32-byte keys base64url-encoded; base64 is what
  // sing-box / the WARP API expect.
  return {
    publicKey: b64uToB64(pubJwk.x),
    privateKey: b64uToB64(privJwk.d),
  };
}

/**
 * Register a new WARP device with Cloudflare.
 *
 * @param {object} [overrides] - test hooks
 * @returns {Promise<object|null>} tunnel params, or null on failure:
 *   { privateKey, v4, v6, reserved, clientId, license, peerKey }
 */
export async function registerWarpDevice(overrides = {}) {
  let keypair;
  try {
    keypair = overrides.keypair ?? generateWgKeypair();
  } catch (e) {
    console.warn("[WARP] keypair generation failed:", e?.message || e);
    return null;
  }

  const body = JSON.stringify({
    key: keypair.publicKey,
    install_id: "",
    fcm_token: "",
    tos: "2024-01-01T00:00:00.000+00:00",
    model: "PC",
    serial_number: "9router",
    locale: "en_US",
  });

  try {
    // Registration is a control-plane call; it must go direct, NOT through the
    // tunnel we are about to build (chicken-and-egg) and NOT through the
    // patched global fetch's env-proxy path.
    const response = await fetch(overrides.regUrl || WARP_REG_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": WARP_REG_USER_AGENT,
      },
      body,
      signal: AbortSignal.timeout(overrides.timeoutMs || 45000),
    });
    if (!response.ok) {
      console.warn(`[WARP] registration rejected: HTTP ${response.status}`);
      return null;
    }
    const data = await response.json();
    return parseRegistration(data, keypair);
  } catch (e) {
    console.warn("[WARP] registration failed:", e?.message || e);
    return null;
  }
}

/**
 * Turn the WARP API response into the flat tunnel params the manager needs.
 * Exported for unit tests.
 */
export function parseRegistration(data, keypair) {
  try {
    const cfg = data?.config;
    if (!cfg) return null;
    const clientId = cfg.client_id;
    if (!clientId) return null;

    // client_id is a 3-byte base64 value = the WireGuard "reserved" field.
    // The server uses it to distinguish devices behind one tunnel, so it is
    // mandatory.
    const reserved = Array.from(Buffer.from(clientId, "base64").slice(0, 3));

    const v4 = cfg?.interface?.addresses?.v4;
    const v6 = cfg?.interface?.addresses?.v6;
    if (!v4 || !v6) return null;

    return {
      privateKey: keypair.privateKey,
      publicKey: keypair.publicKey,
      v4,
      v6,
      reserved,
      clientId,
      license: data?.account?.license || "",
      // The peer key returned by the API is authoritative; fall back to the
      // known-stable key if the field is missing.
      peerKey: cfg?.peers?.[0]?.public_key || WARP_PEER_KEY,
    };
  } catch (e) {
    console.warn("[WARP] could not parse registration response:", e?.message || e);
    return null;
  }
}

export default registerWarpDevice;
