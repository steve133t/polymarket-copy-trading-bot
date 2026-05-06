'use client';

import { useEffect, useState, useCallback } from 'react';

const POLL_INTERVAL_MS = 30_000;

export function useBotStatus(): boolean | null {
  const [online, setOnline] = useState<boolean | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/bot-status');
      if (!res.ok) return;
      const data = await res.json();
      setOnline(data.online ?? false);
    } catch {
      setOnline(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchStatus]);

  return online;
}
