/**
 * Egress probing through the WARP SOCKS5 inbound.
 *
 * We need to (a) confirm the WireGuard handshake completed and (b) read back
 * which colo/IP we are exiting from. Both come from fetching Cloudflare's
 * trace endpoint THROUGH the tunnel.
 *
 * This deliberately uses a node-http + SocksProxyAgent wrapper instead of
 * undici's ProxyAgent: undici has no SOCKS support. The same approach is
 * already used by src/lib/mimoLoginSession.js for SOCKS egress.
 */
import { WARP_TRACE_URL, WARP_SOCKS_HOST, WARP_SOCKS_PORT } from "./constants.js";

let _socksPromise = null;

async function getSocksAgent() {
  if (!_socksPromise) {
    // Literal specifier — webpack forbids fully dynamic import().
    _socksPromise = import("socks-proxy-agent")
      .then((m) => m.SocksProxyAgent || m.default?.SocksProxyAgent || m.default)
      .catch((e) => {
        console.warn("[WARP] socks-proxy-agent unavailable:", e?.message || e);
        return null;
      });
  }
  return _socksPromise;
}

export function warpSocksUrl(socksPort = WARP_SOCKS_PORT) {
  return `socks5://${WARP_SOCKS_HOST}:${socksPort}`;
}

/**
 * fetch() through the WARP SOCKS5 proxy. Returns a standard Response.
 *
 * The probe MUST go through the proxy (that is the whole point), and it must
 * never pick up the app's env-proxy instead — so this calls node http/https
 * directly with an explicit agent rather than the patched global fetch.
 */
export async function warpFetch(url, init = {}, socksPort = WARP_SOCKS_PORT) {
  const SocksProxyAgent = await getSocksAgent();
  if (!SocksProxyAgent) throw new Error("socks agent unavailable");

  const nodeUrl = new URL(url);
  const protoMod = nodeUrl.protocol === "http:" ? await import("node:http") : await import("node:https");
  const lib = protoMod.default ?? protoMod;
  const { Readable } = await import("node:stream");

  let headers = {};
  const raw = init?.headers;
  if (raw instanceof Headers) for (const [k, v] of raw) headers[k] = v;
  else if (raw) headers = { ...raw };

  let body = init?.body;
  if (body && typeof body !== "string" && !Buffer.isBuffer(body)) body = Buffer.from(body);
  if (body) headers["content-length"] = String(Buffer.byteLength(body));

  const agent = new SocksProxyAgent(warpSocksUrl(socksPort));
  return new Promise((resolve, reject) => {
    const req = lib.request(
      nodeUrl,
      { method: init?.method || "GET", agent, headers, timeout: init?.timeoutMs || 10000 },
      (res) => {
        const outHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers || {})) {
          if (Array.isArray(v)) v.forEach((x) => outHeaders.append(k, String(x)));
          else if (v != null) outHeaders.set(k, String(v));
        }
        resolve(new Response(Readable.toWeb(res), { status: res.statusCode || 200, headers: outHeaders }));
      },
    );
    const signal = init?.signal;
    if (signal) {
      if (signal.aborted) req.destroy(new Error("aborted"));
      else signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
    }
    req.on("timeout", () => req.destroy(new Error("warp fetch timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Probe the egress through the tunnel.
 * @returns {Promise<{ip: string, colo: string}>} empty strings if not up yet
 */
export async function probeWarpEgress(socksPort = WARP_SOCKS_PORT) {
  try {
    const res = await warpFetch(WARP_TRACE_URL, { timeoutMs: 9000 }, socksPort);
    if (!res.ok) return { ip: "", colo: "" };
    const text = await res.text();
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      out[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return { ip: out.ip || "", colo: out.colo || "" };
  } catch {
    // Not up yet, or the handshake is still in progress.
    return { ip: "", colo: "" };
  }
}
