import { useConnectionStatus } from '@/hooks/useWebSocket';

/**
 * Tells the user when real-time delivery is down. Sends typed meanwhile stay
 * in the outbox and go out (deduplicated by client ID) after reconnecting,
 * and the server pushes this device's missed messages on reconnect.
 */
export function ConnectionBanner() {
  const status = useConnectionStatus();
  if (status === 'open' || status === 'closed') return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="px-4 py-1.5 text-xs text-center text-amber-800 bg-amber-50 border-b border-amber-200"
    >
      {status === 'connecting' ? 'Connecting…' : 'Reconnecting… messages you send will go out when the connection is back'}
    </div>
  );
}
