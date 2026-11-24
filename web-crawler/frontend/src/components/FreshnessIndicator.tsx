/**
 * @fileoverview "Live · updated 3s ago" indicator that tells the truth.
 *
 * The old indicator was a permanently pulsing green "Live" dot - it stayed
 * green while the backend was down and the numbers on screen were minutes old.
 * This one derives its state from the age of the snapshot:
 * - Live: last successful poll within 3 intervals
 * - Stale: older than that (or polls are failing); shows the age and when the
 *   next retry happens
 * - Connecting: no snapshot yet
 *
 * State changes are announced through a polite live region; the per-second
 * age text is not, so screen readers aren't flooded.
 *
 * @module components/FreshnessIndicator
 */

import { useEffect, useState } from 'react';
import { useCrawlerStore, POLL_INTERVAL_MS } from '../stores/crawlerStore';

const STALE_AFTER_MS = POLL_INTERVAL_MS * 3;

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

export function FreshnessIndicator() {
  const fetchedAt = useCrawlerStore((s) => s.statsFetchedAt);
  const errors = useCrawlerStore((s) => s.consecutiveErrors);
  const nextPollInMs = useCrawlerStore((s) => s.nextPollInMs);
  const now = useNow();

  const age = fetchedAt === null ? null : now - fetchedAt;
  const state = age === null ? 'connecting' : age > STALE_AFTER_MS || errors > 0 ? 'stale' : 'live';

  const dot = {
    live: 'bg-green-500 animate-pulse',
    stale: 'bg-amber-500',
    connecting: 'bg-gray-400 animate-pulse',
  }[state];

  const label = {
    live: 'Live',
    stale: 'Stale',
    connecting: 'Connecting…',
  }[state];

  return (
    <div className="flex items-center space-x-2">
      <span className={`w-2 h-2 rounded-full ${dot}`} aria-hidden="true"></span>
      <span className="text-sm text-gray-700" role="status" aria-live="polite">
        {label}
      </span>
      {age !== null && (
        <span className="text-sm text-gray-500">
          · updated {formatAge(age)} ago
          {errors > 0 && ` · retrying in ${formatAge(nextPollInMs)}`}
        </span>
      )}
    </div>
  );
}
