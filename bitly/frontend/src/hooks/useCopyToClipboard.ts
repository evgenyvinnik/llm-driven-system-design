/**
 * Clipboard hook with visible success/failure state.
 * Copying can fail (no Clipboard API outside secure contexts, permission denied), and the
 * user needs to know so they can copy the link manually.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyStatus = 'idle' | 'copied' | 'failed';

/**
 * @param resetAfterMs - How long the copied/failed state stays visible
 * @returns copy() plus the status and the text it applies to (for lists with many buttons)
 */
export function useCopyToClipboard(resetAfterMs = 2500) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      window.clearTimeout(timer.current);
      let ok = false;
      try {
        if (!navigator.clipboard) {
          throw new Error('Clipboard API unavailable');
        }
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        ok = false;
      }
      setCopiedText(text);
      setStatus(ok ? 'copied' : 'failed');
      timer.current = window.setTimeout(() => setStatus('idle'), resetAfterMs);
      return ok;
    },
    [resetAfterMs]
  );

  return { copy, status, copiedText };
}
