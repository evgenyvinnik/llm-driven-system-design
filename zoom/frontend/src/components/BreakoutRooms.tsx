import { useEffect, useState } from 'react';
import * as api from '../services/api';
import { useMeetingStore } from '../stores/meetingStore';

interface BreakoutRoomsProps {
  meetingId: string;
}

/**
 * Host UI for breakout rooms: create, assign participants, open and close.
 * Rooms and assignments come from the server (and its breakout-rooms-* pushes);
 * the old panel kept rooms in local state, showed "0 participants" for every
 * room, and had no way to assign anyone.
 */
export function BreakoutRooms({ meetingId }: BreakoutRoomsProps) {
  const { breakoutRooms, breakoutOpen, participants, setBreakoutRooms, setNotice } = useMeetingStore();
  const [roomCount, setRoomCount] = useState(2);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getBreakoutRooms(meetingId)
      .then(({ rooms }) => setBreakoutRooms(rooms, rooms.some((r) => r.isActive)))
      .catch((err) => setNotice((err as Error).message));
  }, [meetingId, setBreakoutRooms, setNotice]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = () =>
    run(async () => {
      const rooms = Array.from({ length: roomCount }, (_, i) => ({ name: `Breakout Room ${i + 1}` }));
      const result = await api.createBreakoutRooms(meetingId, rooms);
      setBreakoutRooms(result.rooms);
    });

  const roomOf = (userId: string) => breakoutRooms.find((r) => r.participants.some((p) => p.userId === userId));

  return (
    <div className="w-72 bg-zoom-surface border-l border-zoom-card flex flex-col h-full">
      <div className="px-4 py-3 border-b border-zoom-card">
        <h2 className="text-sm font-semibold text-zoom-text">Breakout Rooms</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {breakoutRooms.length === 0 ? (
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-zoom-secondary mb-1">Number of rooms</label>
              <input
                type="number"
                value={roomCount}
                onChange={(e) => setRoomCount(Math.min(20, Math.max(1, parseInt(e.target.value) || 1)))}
                min={1}
                max={20}
                className="w-20 bg-zoom-card border border-zoom-card rounded px-3 py-2 text-sm text-zoom-text focus:outline-none focus:border-zoom-primary"
              />
            </div>
            <button
              onClick={handleCreate}
              disabled={busy}
              className="w-full bg-zoom-primary hover:bg-zoom-hover disabled:opacity-50 text-white py-2 rounded-lg text-sm font-medium transition-colors"
            >
              Create Rooms
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {breakoutRooms.map((room) => (
              <div key={room.id} className="bg-zoom-card rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-zoom-text font-medium">{room.name}</span>
                  <span className="text-xs text-zoom-secondary">
                    {room.participants.length} participant{room.participants.length === 1 ? '' : 's'}
                  </span>
                </div>
                {room.participants.length > 0 && (
                  <div className="text-xs text-zoom-secondary mt-1">
                    {room.participants.map((p) => p.displayName).join(', ')}
                  </div>
                )}
              </div>
            ))}

            <h3 className="text-xs font-semibold text-zoom-secondary uppercase pt-2">Assign</h3>
            {participants.map((p) => (
              <div key={p.userId} className="flex items-center gap-2">
                <span className="flex-1 text-sm text-zoom-text truncate">{p.displayName}</span>
                <select
                  value={roomOf(p.userId)?.id ?? ''}
                  disabled={busy}
                  onChange={(e) => e.target.value && run(() => api.assignToBreakoutRoom(e.target.value, p.userId))}
                  className="bg-zoom-card border border-zoom-card rounded px-2 py-1 text-xs text-zoom-text"
                >
                  <option value="">Main room</option>
                  {breakoutRooms.map((room) => (
                    <option key={room.id} value={room.id}>
                      {room.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}

            <div className="flex gap-2 mt-4">
              <button
                onClick={() => run(() => api.activateBreakoutRooms(meetingId))}
                disabled={busy || breakoutOpen}
                className="flex-1 bg-zoom-green hover:bg-green-700 disabled:opacity-50 text-white py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {breakoutOpen ? 'Open' : 'Open All'}
              </button>
              <button
                onClick={() => run(() => api.closeBreakoutRooms(meetingId))}
                disabled={busy}
                className="flex-1 bg-zoom-red hover:bg-red-700 disabled:opacity-50 text-white py-2 rounded-lg text-sm font-medium transition-colors"
              >
                Close All
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
