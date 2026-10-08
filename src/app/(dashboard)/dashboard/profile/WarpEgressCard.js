"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Toggle } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

const POLL_INTERVAL_MS = 5000;

function statusBadge(status) {
  if (!status.installed) return <Badge variant="default">Not installed</Badge>;
  if (status.running && status.enabled) return <Badge variant="success" dot>Egress {status.colo || "up"}</Badge>;
  if (status.running) return <Badge variant="warning" dot>Connecting…</Badge>;
  if (status.enabled) return <Badge variant="warning">Tunnel down</Badge>;
  return <Badge variant="default">Off</Badge>;
}

export default function WarpEgressCard() {
  const [status, setStatus] = useState(null);
  const [autoRotate, setAutoRotate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const notify = useNotificationStore();

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/warp/status", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setStatus(data);
        setAutoRotate(data.autoRotate !== false);
      }
    } catch {
      /* keep last known status */
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const handleToggle = useCallback(async (enabled) => {
    setBusy(true);
    setError("");
    try {
      const endpoint = enabled ? "/api/warp/enable" : "/api/warp/disable";
      const res = await fetch(endpoint, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Operation failed");
        notify.error(`WARP: ${data.error || "operation failed"}`);
      } else if (data.error) {
        setError(data.error);
      } else {
        notify.success(enabled ? "WARP egress enabled" : "WARP egress disabled");
      }
      await fetchStatus();
    } catch (e) {
      setError(e?.message || "Network error");
    } finally {
      setBusy(false);
    }
  }, [fetchStatus, notify]);

  const handleRotate = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/warp/rotate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "panel manual" }),
      });
      const data = await res.json();
      if (res.status === 409 && data.busy) {
        notify.info("A rotation is already in progress");
      } else if (!res.ok) {
        setError(data.error || "Rotation failed");
        notify.error(`WARP: ${data.error || "rotation failed"}`);
      } else {
        notify.success(`Rotated to ${data.colo || "new egress"}`);
      }
      await fetchStatus();
    } catch (e) {
      setError(e?.message || "Network error");
    } finally {
      setBusy(false);
    }
  }, [fetchStatus, notify]);

  const handleAutoRotate = useCallback(async (enabled) => {
    setAutoRotate(enabled);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ warpAutoRotate: enabled }),
      });
    } catch {
      setAutoRotate(!enabled);
    }
  }, []);

  const enabled = status?.enabled === true;
  const installed = status?.installed === true;
  const canControl = status?.canControl !== false;

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-orange-500/10 text-orange-500 shrink-0">
          <span className="material-symbols-outlined text-[20px]">vpn_lock</span>
        </div>
        <h3 className="text-base sm:text-lg font-semibold flex-1">WARP Egress</h3>
        {statusBadge(status || {})}
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex items-start sm:items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm sm:text-base">Cloudflare WARP tunnel</p>
            <p className="text-xs sm:text-sm text-text-muted">
              Route upstream requests through a free WireGuard tunnel. Rotating the endpoint changes the egress IP
              providers see — useful when every account gets 429&apos;d in one colo.
            </p>
          </div>
          <Toggle
            checked={enabled}
            onChange={handleToggle}
            disabled={busy || !installed || !canControl}
          />
        </div>

        {!canControl && (
          <p className="text-xs sm:text-sm text-text-muted">
            Enable/disable and rotation are only available from a local connection — they
            change the gateway&apos;s egress for every request.
          </p>
        )}

        {!installed && (
          <p className="text-xs sm:text-sm text-yellow-600 dark:text-yellow-400">
            sing-box is not installed or not on PATH. Install it (<code className="px-1 py-0.5 rounded bg-surface-2 text-[11px]">pkg install sing-box</code> on
            Termux, or your system package manager) to use WARP egress.
          </p>
        )}

        {installed && enabled && status && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Endpoint" value={status.endpoint || "—"} mono />
            <Stat label="Colo" value={status.colo || "—"} mono />
            <Stat label="Egress IP" value={status.ip || "—"} mono />
            <Stat label="Proxy" value={status.socksPort ? `socks5 127.0.0.1:${status.socksPort}` : "—"} mono />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="secondary"
            onClick={handleRotate}
            disabled={busy || !enabled || !canControl}
          >
            <span className="material-symbols-outlined text-[16px] mr-1">sync</span>
            Rotate egress IP
          </Button>

          <Toggle
            checked={autoRotate}
            onChange={handleAutoRotate}
            disabled={busy}
            size="sm"
            label="Auto-rotate on 429 sweep"
          />
        </div>

        {error && (
          <p className="text-xs sm:text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </div>
    </Card>
  );
}

function Stat({ label, value, mono }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-text-muted">{label}</p>
      <p className={`text-sm font-medium truncate ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}
