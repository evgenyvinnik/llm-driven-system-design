import { useMeetingStore } from '../stores/meetingStore';
import { wsClient } from '../services/websocket';

/** Host/co-host view of the waiting room with Admit and Deny for each person. */
export function WaitingRoomList() {
  const { waiting } = useMeetingStore();
  if (waiting.length === 0) return null;

  return (
    <div className="border-b border-zoom-card p-2" aria-label="Waiting room">
      <h3 className="px-3 py-1 text-xs font-semibold text-yellow-500 uppercase">Waiting room ({waiting.length})</h3>
      {waiting.map((w) => (
        <div key={w.userId} className="flex items-center gap-2 px-3 py-2">
          <span className="flex-1 text-sm text-zoom-text truncate">{w.displayName}</span>
          <button
            onClick={() => wsClient.admitParticipant(w.userId)}
            className="text-xs bg-zoom-primary hover:bg-zoom-hover text-white px-2 py-1 rounded"
          >
            Admit
          </button>
          <button
            onClick={() => wsClient.denyParticipant(w.userId)}
            className="text-xs bg-zinc-700 hover:bg-zinc-600 text-zoom-text px-2 py-1 rounded"
          >
            Deny
          </button>
        </div>
      ))}
    </div>
  );
}
