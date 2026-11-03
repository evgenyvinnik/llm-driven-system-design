import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useMeetingStore } from '../stores/meetingStore';
import { useMediaStore } from '../stores/mediaStore';
import { useMeetingConnection } from '../hooks/useMeetingConnection';
import * as api from '../services/api';
import { MeetingLobby } from '../components/MeetingLobby';
import { VideoGrid } from '../components/VideoGrid';
import { ControlBar } from '../components/ControlBar';
import { ChatPanel } from '../components/ChatPanel';
import { ParticipantList } from '../components/ParticipantList';
import { BreakoutRooms } from '../components/BreakoutRooms';
import { MeetingNotice } from '../components/MeetingNotice';
import { MeetingMessageScreen } from '../components/MeetingMessageScreen';
import type { Meeting } from '../types';

export const Route = createFileRoute('/meeting/$code')({
  component: MeetingPage,
});

function MeetingPage() {
  const { code } = Route.useParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { meeting, setMeeting, isChatOpen, isParticipantListOpen, isBreakoutOpen, reset: resetMeeting } =
    useMeetingStore();
  const { reset: resetMedia } = useMediaStore();
  const { phase, closedMessage, join, leave } = useMeetingConnection(code, user?.id);

  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Load meeting info
  useEffect(() => {
    if (!user) return;
    setDisplayName(user.displayName || user.username);

    api.getMeetingByCode(code).then(({ meeting: m }) => {
      const meetingData: Meeting = {
        id: m.id as string,
        meetingCode: (m.meeting_code as string) || '',
        title: (m.title as string) || 'Meeting',
        hostId: (m.host_id as string) || '',
        scheduledStart: (m.scheduled_start as string) || null,
        scheduledEnd: (m.scheduled_end as string) || null,
        actualStart: (m.actual_start as string) || null,
        actualEnd: (m.actual_end as string) || null,
        status: (m.status as Meeting['status']) || 'scheduled',
        settings: (m.settings as Meeting['settings']) || { waitingRoom: false, muteOnEntry: false, allowScreenShare: true, maxParticipants: 100 },
        createdAt: (m.created_at as string) || '',
      };
      setMeeting(meetingData);
      setLoading(false);
    }).catch(() => {
      setError('Meeting not found');
      setLoading(false);
    });

    return () => {
      resetMeeting();
      resetMedia();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, user]);

  const backToDashboard = () => navigate({ to: '/' });

  const handleLeave = () => {
    leave();
    backToDashboard();
  };

  if (!user) return null;

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-zoom-primary">Loading meeting...</div>
      </div>
    );
  }

  if (error || !meeting) {
    return <MeetingMessageScreen message={error || 'Meeting not found'} onBack={backToDashboard} />;
  }

  if (phase === 'closed') {
    return <MeetingMessageScreen title={meeting.title} message={closedMessage} onBack={backToDashboard} />;
  }

  // Ended meetings are terminal; offering "Join" would only produce a rejection.
  if (phase === 'lobby' && (meeting.status === 'ended' || meeting.status === 'cancelled')) {
    return (
      <MeetingMessageScreen
        title={meeting.title}
        message={meeting.status === 'ended' ? 'This meeting has ended.' : 'This meeting was cancelled.'}
        onBack={backToDashboard}
      />
    );
  }

  if (phase === 'waiting') {
    return (
      <MeetingMessageScreen
        title={meeting.title}
        message="Please wait, the host will let you in soon."
        detail="You are in the waiting room."
        backLabel="Leave waiting room"
        onBack={handleLeave}
        waiting
      />
    );
  }

  if (phase === 'lobby' || phase === 'joining') {
    return (
      <MeetingLobby
        meetingTitle={meeting.title}
        meetingCode={code}
        displayName={displayName}
        onDisplayNameChange={setDisplayName}
        onJoin={() => displayName.trim() && join(displayName.trim())}
        loading={phase === 'joining'}
        waitingRoom={meeting.settings.waitingRoom}
      />
    );
  }

  // In-meeting view
  return (
    <div className="flex flex-col h-full relative">
      <MeetingNotice />
      <div className="flex flex-1 overflow-hidden">
        {/* Main video area */}
        <div className="flex-1 min-w-0">
          <VideoGrid />
        </div>

        {/* Side panels */}
        {isChatOpen && <ChatPanel />}
        {isParticipantListOpen && <ParticipantList />}
        {isBreakoutOpen && <BreakoutRooms meetingId={meeting.id} />}
      </div>

      {/* Control bar */}
      <ControlBar onLeave={handleLeave} />
    </div>
  );
}
