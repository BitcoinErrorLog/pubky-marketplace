'use client';

import { useEffect, useState } from 'react';

/** Wall-clock milliseconds, refreshed every second while `active`. */
export function useNowMs(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  return nowMs;
}
