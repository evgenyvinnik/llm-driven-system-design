import { wsClient } from '../services/websocket';
import type { Participant, Role } from '../types';

const RANK: Record<Role, number> = { participant: 0, 'co-host': 1, host: 2 };

interface ParticipantActionsProps {
  participant: Participant;
  myRole: Role;
}

/**
 * Host controls for one participant. Mirrors the server rule (act only on
 * someone ranked below you); the server enforces it regardless of what renders.
 */
export function ParticipantActions({ participant: p, myRole }: ParticipantActionsProps) {
  if (RANK[myRole] < RANK['co-host'] || RANK[p.role] >= RANK[myRole]) return null;

  const button = 'text-[10px] px-1.5 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zoom-text';
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {!p.isMuted && (
        <button className={button} onClick={() => wsClient.muteParticipant(p.userId)}>
          Mute
        </button>
      )}
      {myRole === 'host' && (
        <>
          <button
            className={button}
            onClick={() => wsClient.setRole(p.userId, p.role === 'co-host' ? 'participant' : 'co-host')}
          >
            {p.role === 'co-host' ? 'Remove co-host' : 'Make co-host'}
          </button>
          <button
            className={button}
            onClick={() => window.confirm(`Make ${p.displayName} the host?`) && wsClient.transferHost(p.userId)}
          >
            Make host
          </button>
        </>
      )}
      <button
        className="text-[10px] px-1.5 py-0.5 rounded bg-zoom-red/80 hover:bg-zoom-red text-white"
        onClick={() => window.confirm(`Remove ${p.displayName}? They will not be able to rejoin.`) && wsClient.removeParticipant(p.userId)}
      >
        Remove
      </button>
    </div>
  );
}
