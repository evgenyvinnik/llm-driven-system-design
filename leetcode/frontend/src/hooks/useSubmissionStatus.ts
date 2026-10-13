import { useEffect, useState } from 'react';
import { ApiError, submissionsApi, type SubmissionStatusResponse } from '../services/api';

const TERMINAL = new Set([
  'accepted', 'wrong_answer', 'time_limit_exceeded', 'memory_limit_exceeded',
  'output_limit_exceeded', 'runtime_error', 'compile_error', 'system_error',
]);

/** Poll delays: quick at first (most runs finish in seconds), then backing off to 5 s. */
const DELAYS_MS = [500, 1000, 1000, 1500, 2000, 3000, 5000];
/** Stop polling after this long; the verdict still lands in the Submissions tab. */
const MAX_POLL_MS = 5 * 60 * 1000;

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}

export interface PolledStatus {
  data: SubmissionStatusResponse | null;
  /** Polling ended without a verdict (gave up after MAX_POLL_MS, or the submission is gone). */
  stalled: boolean;
}

/**
 * Polls GET /submissions/:id/status until a verdict arrives. Each request can be aborted, and
 * the effect cleanup stops the loop, so leaving the page or submitting again never leaves a
 * timer writing into an unmounted component. Network errors keep polling with backoff.
 */
export function useSubmissionStatus(submissionId: string | null, onTerminal?: (status: SubmissionStatusResponse) => void): PolledStatus {
  const [state, setState] = useState<PolledStatus>({ data: null, stalled: false });

  useEffect(() => {
    if (!submissionId) return;
    const controller = new AbortController();
    const startedAt = Date.now();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ data: null, stalled: false });

    const poll = async (): Promise<void> => {
      try {
        const data = await submissionsApi.getStatus(submissionId, controller.signal);
        if (controller.signal.aborted) return;
        setState({ data, stalled: false });
        if (isTerminalStatus(data.status)) {
          onTerminal?.(data);
          return;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && (error.status === 404 || error.status === 401)) {
          setState((previous) => ({ ...previous, stalled: true }));
          return;
        }
        // Network error, 429 or 5xx: keep trying with the same backoff.
      }
      if (Date.now() - startedAt > MAX_POLL_MS) {
        setState((previous) => ({ ...previous, stalled: true }));
        return;
      }
      timer = setTimeout(poll, DELAYS_MS[Math.min(attempt++, DELAYS_MS.length - 1)]);
    };

    timer = setTimeout(poll, DELAYS_MS[0]);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // onTerminal is intentionally not a dependency: a new callback must not restart polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissionId]);

  return state;
}
