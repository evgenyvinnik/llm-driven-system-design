import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { MeetingCard } from '../components/MeetingCard';
import { JoinByCode } from '../components/JoinByCode';
import * as api from '../services/api';

export const Route = createFileRoute('/')({
  component: Dashboard,
});

interface MeetingData {
  id: string;
  meeting_code: string;
  title: string;
  scheduled_start: string | null;
  status: string;
}

function Dashboard() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [meetings, setMeetings] = useState<MeetingData[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  useEffect(() => {
    if (!user) return;
    loadMeetings();
  }, [user]);

  const loadMeetings = async () => {
    try {
      const { meetings: data } = await api.getMeetings();
      setMeetings(data as unknown as MeetingData[]);
    } catch (err) {
      console.error('Failed to load meetings:', err);
    } finally {
      setLoading(false);
    }
  };

  // Disabled while in flight, and keyed so a retried request cannot create a
  // second meeting (double clicks used to leave orphaned "Instant Meeting"s).
  const startInstantMeeting = async () => {
    setCreating(true);
    setCreateError('');
    try {
      const { meeting } = await api.createMeeting({ title: 'Instant Meeting' }, crypto.randomUUID());
      navigate({ to: '/meeting/$code', params: { code: meeting.meeting_code as string } });
    } catch (err) {
      setCreateError((err as Error).message);
      setCreating(false);
    }
  };

  if (!user) return null;

  const upcomingMeetings = meetings.filter(
    (m) => m.status === 'scheduled' || m.status === 'active'
  );

  return (
    <div className="max-w-5xl mx-auto p-6 overflow-y-auto h-full">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-zoom-text mb-1">
          Welcome, {user.displayName}
        </h1>
        <p className="text-zoom-secondary">Manage your meetings and join calls</p>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        <div className="bg-zoom-card rounded-xl p-5 border border-zoom-surface">
          <h2 className="text-lg font-semibold text-zoom-text mb-3">Join a Meeting</h2>
          <JoinByCode />
        </div>

        <div className="bg-zoom-card rounded-xl p-5 border border-zoom-surface">
          <h2 className="text-lg font-semibold text-zoom-text mb-3">Start a New Meeting</h2>
          <div className="flex gap-3">
            <button
              onClick={startInstantMeeting}
              disabled={creating}
              className="flex-1 bg-zoom-primary hover:bg-zoom-hover disabled:opacity-50 text-white py-2.5 px-4 rounded-lg font-medium transition-colors"
            >
              {creating ? 'Starting...' : 'New Meeting'}
            </button>
            <button
              onClick={() => navigate({ to: '/schedule' })}
              className="flex-1 bg-zoom-surface hover:bg-zoom-card text-zoom-text py-2.5 px-4 rounded-lg font-medium transition-colors border border-zoom-card"
            >
              Schedule
            </button>
          </div>
          {createError && <p className="text-zoom-red text-sm mt-2">{createError}</p>}
        </div>
      </div>

      {/* Upcoming meetings */}
      <div>
        <h2 className="text-lg font-semibold text-zoom-text mb-4">
          Upcoming Meetings ({upcomingMeetings.length})
        </h2>

        {loading ? (
          <div className="text-zoom-secondary text-center py-8">Loading meetings...</div>
        ) : upcomingMeetings.length === 0 ? (
          <div className="bg-zoom-card rounded-xl p-8 text-center border border-zoom-surface">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="#A0A0A0" className="mx-auto mb-3">
              <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
            </svg>
            <p className="text-zoom-secondary">No upcoming meetings</p>
            <p className="text-zoom-secondary text-sm mt-1">Schedule a meeting or join one by code</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {upcomingMeetings.map((meeting) => (
              <MeetingCard
                key={meeting.id}
                title={meeting.title}
                meetingCode={meeting.meeting_code}
                scheduledStart={meeting.scheduled_start}
                status={meeting.status}
                onJoin={() =>
                  navigate({ to: '/meeting/$code', params: { code: meeting.meeting_code } })
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
