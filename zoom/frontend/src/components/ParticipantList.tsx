import { useMeetingStore } from '../stores/meetingStore';
import { useAuthStore } from '../stores/authStore';
import { wsClient } from '../services/websocket';
import { getInitials } from '../utils/format';
import { WaitingRoomList } from './WaitingRoomList';
import { ParticipantActions } from './ParticipantActions';

/** Renders the side panel listing all meeting participants with their media status. */
export function ParticipantList() {
  const { participants, myRole } = useMeetingStore();
  const { user } = useAuthStore();
  const isManager = myRole === 'host' || myRole === 'co-host';

  return (
    <div className="w-72 bg-zoom-surface border-l border-zoom-card flex flex-col h-full">
      <div className="px-4 py-3 border-b border-zoom-card flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zoom-text">Participants ({participants.length})</h2>
        {isManager && participants.length > 1 && (
          <button
            onClick={() => wsClient.muteAll()}
            className="text-xs bg-zinc-700 hover:bg-zinc-600 text-zoom-text px-2 py-1 rounded"
          >
            Mute all
          </button>
        )}
      </div>

      {isManager && <WaitingRoomList />}

      <div className="flex-1 overflow-y-auto p-2">
        {participants.map((p) => (
          <div
            key={p.userId}
            className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-zoom-card transition-colors"
          >
            <div className="w-8 h-8 rounded-full bg-zoom-primary flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
              {getInitials(p.displayName)}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-zoom-text truncate">
                  {p.displayName}
                  {p.userId === user?.id && ' (You)'}
                </span>
                {p.role === 'host' && (
                  <span className="text-[10px] bg-zoom-primary/20 text-zoom-primary px-1.5 py-0.5 rounded font-medium">
                    Host
                  </span>
                )}
                {p.role === 'co-host' && (
                  <span className="text-[10px] bg-zoom-primary/20 text-zoom-primary px-1.5 py-0.5 rounded font-medium">
                    Co-host
                  </span>
                )}
              </div>
              {p.userId !== user?.id && <ParticipantActions participant={p} myRole={myRole} />}
            </div>

            <div className="flex items-center gap-1">
              {p.isHandRaised && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#EAB308">
                  <path d="M21 7c0-1.38-1.12-2.5-2.5-2.5-.17 0-.34.02-.5.05V4c0-1.38-1.12-2.5-2.5-2.5-.23 0-.46.03-.67.09C14.46.66 13.56 0 12.5 0c-1.23 0-2.25.89-2.46 2.06C9.87 2.02 9.69 2 9.5 2 8.12 2 7 3.12 7 4.5v5.89c-.34-.31-.76-.51-1.22-.51-.73 0-1.38.45-1.64 1.12l-1.89 4.77C2.09 16.26 2 16.76 2 17.27V20c0 2.21 1.79 4 4 4h9c1.71 0 3.23-1.07 3.82-2.67l2.98-8.04C21.93 13.05 22 12.78 22 12.5V9c0-1.38-1.12-2.5-2.5-2.5-.17 0-.34.02-.5.05V7z" />
                </svg>
              )}
              {p.isScreenSharing && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#00C853">
                  <path d="M20 18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z" />
                </svg>
              )}
              {p.isMuted ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#FF1744">
                  <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#00C853">
                  <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z" />
                </svg>
              )}
              {!p.isVideoOn && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#FF1744">
                  <path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z" />
                </svg>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
