import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import * as api from '../services/api';
import { formatDateTime, formatDuration, formatMeetingCode } from '../utils/format';

export const Route = createFileRoute('/history')({
  component: HistoryPage,
});

interface MeetingData {
  id: string;
  meeting_code: string;
  title: string;
  scheduled_start: string | null;
  actual_start: string | null;
  actual_end: string | null;
  status: string;
}

function HistoryPage() {
  const { user } = useAuthStore();
  const [meetings, setMeetings] = useState<MeetingData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    api
      .getMeetings()
      .then(({ meetings: data }) => setMeetings(data as unknown as MeetingData[]))
      .catch((err) => console.error('Failed to load meetings:', err))
      .finally(() => setLoading(false));
  }, [user]);

  if (!user) return null;

  const pastMeetings = meetings.filter((m) => m.status === 'ended');

  return (
    <div className="max-w-4xl mx-auto p-6 overflow-y-auto h-full">
      <h1 className="text-2xl font-bold text-zoom-text mb-6">Meeting History</h1>

      {loading ? (
        <div className="text-zoom-secondary text-center py-8">Loading...</div>
      ) : pastMeetings.length === 0 ? (
        <div className="bg-zoom-card rounded-xl p-8 text-center border border-zoom-surface">
          <p className="text-zoom-secondary">No past meetings</p>
        </div>
      ) : (
        <div className="space-y-3">
          {pastMeetings.map((meeting) => (
            <div
              key={meeting.id}
              className="bg-zoom-card rounded-lg p-4 border border-zoom-surface"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-zoom-text font-medium">{meeting.title}</h3>
                  <div className="flex items-center gap-4 mt-1 text-sm text-zoom-secondary">
                    <span className="font-mono">{formatMeetingCode(meeting.meeting_code)}</span>
                    {meeting.actual_start && (
                      <span>{formatDateTime(meeting.actual_start)}</span>
                    )}
                    {meeting.actual_start && meeting.actual_end && (
                      <span>Duration: {formatDuration(meeting.actual_start, meeting.actual_end)}</span>
                    )}
                  </div>
                </div>
                <span className="text-xs text-zoom-secondary uppercase font-medium">{meeting.status}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
