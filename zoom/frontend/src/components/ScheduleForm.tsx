import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import * as api from '../services/api';

/** Renders the meeting scheduling form with title, date/time, and settings. */
export function ScheduleForm() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [scheduledStart, setScheduledStart] = useState('');
  const [scheduledEnd, setScheduledEnd] = useState('');
  const [muteOnEntry, setMuteOnEntry] = useState(false);
  const [waitingRoom, setWaitingRoom] = useState(false);
  const [allowScreenShare, setAllowScreenShare] = useState(true);
  const [maxParticipants, setMaxParticipants] = useState(100);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // One key per filled-in form: a double submit or retry returns the same meeting.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // datetime-local values carry no zone ("2026-11-02T10:00"); sent as-is the
    // server read them as UTC, shifting the meeting by the user's offset.
    // new Date() interprets them in the browser's zone; toISOString() makes that explicit.
    const start = scheduledStart ? new Date(scheduledStart) : null;
    const end = scheduledEnd ? new Date(scheduledEnd) : null;
    if (end && !start) {
      setError('Set a start time before an end time');
      return;
    }
    if (start && end && end <= start) {
      setError('End time must be after start time');
      return;
    }

    setLoading(true);
    try {
      const result = await api.createMeeting(
        {
          title: title || 'Untitled Meeting',
          scheduledStart: start?.toISOString(),
          scheduledEnd: end?.toISOString(),
          settings: { muteOnEntry, waitingRoom, allowScreenShare, maxParticipants },
        },
        idempotencyKey
      );
      const meeting = result.meeting;
      const code = (meeting.meeting_code as string) || (meeting.meetingCode as string);
      navigate({ to: '/meeting/$code', params: { code } });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-lg">
      {error && (
        <div className="bg-zoom-red/20 border border-zoom-red text-zoom-red rounded-lg px-4 py-3 text-sm">
          {error}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-zoom-secondary mb-1">Meeting Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Weekly Team Standup"
          className="w-full bg-zoom-surface border border-zoom-card rounded-lg px-4 py-2.5 text-zoom-text placeholder-zoom-secondary focus:outline-none focus:border-zoom-primary"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <p className="col-span-2 text-xs text-zoom-secondary -mb-2">Times are in your time zone ({timeZone}).</p>
        <div>
          <label className="block text-sm font-medium text-zoom-secondary mb-1">Start Time</label>
          <input
            type="datetime-local"
            value={scheduledStart}
            onChange={(e) => setScheduledStart(e.target.value)}
            className="w-full bg-zoom-surface border border-zoom-card rounded-lg px-4 py-2.5 text-zoom-text focus:outline-none focus:border-zoom-primary [color-scheme:dark]"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zoom-secondary mb-1">End Time</label>
          <input
            type="datetime-local"
            value={scheduledEnd}
            onChange={(e) => setScheduledEnd(e.target.value)}
            className="w-full bg-zoom-surface border border-zoom-card rounded-lg px-4 py-2.5 text-zoom-text focus:outline-none focus:border-zoom-primary [color-scheme:dark]"
          />
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zoom-text">Settings</h3>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={muteOnEntry}
            onChange={(e) => setMuteOnEntry(e.target.checked)}
            className="w-4 h-4 rounded accent-zoom-primary"
          />
          <span className="text-sm text-zoom-secondary">Mute participants on entry</span>
        </label>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={waitingRoom}
            onChange={(e) => setWaitingRoom(e.target.checked)}
            className="w-4 h-4 rounded accent-zoom-primary"
          />
          <span className="text-sm text-zoom-secondary">Enable waiting room</span>
        </label>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={allowScreenShare}
            onChange={(e) => setAllowScreenShare(e.target.checked)}
            className="w-4 h-4 rounded accent-zoom-primary"
          />
          <span className="text-sm text-zoom-secondary">Allow screen sharing</span>
        </label>

        <div>
          <label className="block text-sm text-zoom-secondary mb-1">Max Participants</label>
          <input
            type="number"
            value={maxParticipants}
            onChange={(e) => setMaxParticipants(Math.min(1000, Math.max(2, parseInt(e.target.value) || 100)))}
            min={2}
            max={1000}
            className="w-24 bg-zoom-surface border border-zoom-card rounded-lg px-3 py-2 text-zoom-text text-sm focus:outline-none focus:border-zoom-primary"
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-zoom-primary hover:bg-zoom-hover disabled:opacity-50 text-white py-3 rounded-lg font-medium transition-colors"
      >
        {loading ? 'Creating...' : 'Create Meeting'}
      </button>
    </form>
  );
}
