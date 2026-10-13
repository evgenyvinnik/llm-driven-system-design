import { useCallback, useEffect, useRef } from 'react';
import { analyticsApi } from '../services/api';
import type { ViewReport } from '../types';

const VIEWER_KEY = 'loom:viewer-id';
const HEARTBEAT_SECONDS = 15;
const COMPLETION_RATIO = 0.9;

/** A stable anonymous id per browser, so one person counts once in unique viewers. */
function viewerKey(): string {
  try {
    let key = localStorage.getItem(VIEWER_KEY);
    if (!key) {
      key = crypto.randomUUID();
      localStorage.setItem(VIEWER_KEY, key);
    }
    return key;
  } catch {
    return crypto.randomUUID();
  }
}

function freshSession() {
  return { viewId: crypto.randomUUID(), started: false, watched: 0, lastTime: 0, lastSent: 0, completed: false };
}

/**
 * Reports one playback session: a view on first play, a heartbeat every 15 seconds of
 * actual watching, one when 90% is reached, and a beacon when the page is hidden.
 * Every report carries the same viewId, and the server upserts on it, so retries and
 * heartbeats never count as extra views and watch time only grows.
 */
export function useViewTracker(videoId: string | null, enabled: boolean) {
  const session = useRef(freshSession());

  useEffect(() => {
    session.current = freshSession();
  }, [videoId]);

  const report = useCallback(
    (asBeacon = false) => {
      const s = session.current;
      if (!videoId || !enabled || !s.started) return;
      const payload: ViewReport = {
        videoId,
        viewId: s.viewId,
        sessionId: viewerKey(),
        watchDurationSeconds: Math.round(s.watched),
        completed: s.completed,
      };
      s.lastSent = s.watched;
      if (asBeacon && analyticsApi.sendViewBeacon(payload)) return;
      analyticsApi.recordView(payload).catch(() => undefined);
    },
    [videoId, enabled],
  );

  const onPlay = useCallback(() => {
    if (session.current.started) return;
    session.current.started = true;
    report();
  }, [report]);

  const onTimeUpdate = useCallback(
    (time: number, duration: number) => {
      const s = session.current;
      const delta = time - s.lastTime;
      s.lastTime = time;
      if (!s.started) return;
      // Small forward steps are playback; anything else is a seek and isn't watch time.
      if (delta > 0 && delta < 2) s.watched += delta;
      if (!s.completed && Number.isFinite(duration) && duration > 0 && time >= duration * COMPLETION_RATIO) {
        s.completed = true;
        report();
        return;
      }
      if (s.watched - s.lastSent >= HEARTBEAT_SECONDS) report();
    },
    [report],
  );

  const onEnded = useCallback(() => {
    session.current.completed = true;
    report();
  }, [report]);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') report(true);
    };
    const onPageHide = () => report(true);
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
      report(true);
    };
  }, [report]);

  return { onPlay, onTimeUpdate, onEnded };
}
