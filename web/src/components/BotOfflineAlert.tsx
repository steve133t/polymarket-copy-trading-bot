'use client';

import { useEffect, useState, useCallback } from 'react';
import type { BotStatusResponse } from '@/app/api/bot-status/route';

const POLL_INTERVAL_MS = 30_000;

export default function BotOfflineAlert() {
  const [status, setStatus] = useState<BotStatusResponse | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/bot-status');
      if (!res.ok) return;
      const data: BotStatusResponse = await res.json();
      setStatus(data);
      // Re-show alert if bot comes back online then goes offline again
      if (data.online) setDismissed(false);
    } catch {
      // silently ignore network errors
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchStatus]);

  // Nothing to show if online, unknown, or dismissed
  if (!status || status.online || dismissed) return null;

  const ago = status.secondsSinceHeartbeat != null
    ? status.secondsSinceHeartbeat < 120
      ? `${status.secondsSinceHeartbeat}s ago`
      : status.secondsSinceHeartbeat < 3600
        ? `${Math.floor(status.secondsSinceHeartbeat / 60)}m ago`
        : `${Math.floor(status.secondsSinceHeartbeat / 3600)}h ago`
    : 'unknown';

  const lastSeen = status.lastSeen
    ? `Last heartbeat: ${ago}`
    : 'Bot has never connected to the database.';

  return (
    <div
      role="alert"
      className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-start gap-3 max-w-lg w-full mx-4 bg-red-950 border border-red-600 text-red-100 rounded-lg px-4 py-3 shadow-xl"
    >
      {/* Icon */}
      <span className="mt-0.5 shrink-0 text-red-400" aria-hidden>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </span>

      {/* Message */}
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm">Bot is offline</p>
        <p className="text-xs text-red-300 mt-0.5">{lastSeen}</p>
        <p className="text-xs text-red-300">
          Run <code className="font-mono bg-red-900 px-1 rounded">npm run dev</code> in the repo root to restart.
        </p>
      </div>

      {/* Dismiss */}
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="shrink-0 text-red-400 hover:text-red-100 transition-colors mt-0.5"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
