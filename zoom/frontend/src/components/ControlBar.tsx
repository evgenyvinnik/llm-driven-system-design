import { useMeetingStore } from '../stores/meetingStore';
import { useMediaStore } from '../stores/mediaStore';
import { wsClient } from '../services/websocket';

interface ControlBarProps {
  onLeave: () => void;
}

/** Renders the in-meeting control bar with mute, video, screen share, and leave buttons. */
export function ControlBar({ onLeave }: ControlBarProps) {
  const { meeting, participants, myRole, locked, waiting, toggleChat, toggleParticipantList, toggleBreakout, isChatOpen, isParticipantListOpen } = useMeetingStore();
  const { isMuted, isVideoOn, isScreenSharing, isHandRaised, setIsMuted, setIsVideoOn, setIsHandRaised } = useMediaStore();

  // The live role from the server, not "am I the organizer": host can be
  // transferred, and a co-host shares most host controls.
  const isHost = myRole === 'host';
  const isManager = myRole === 'host' || myRole === 'co-host';

  const handleToggleMute = () => {
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    wsClient.toggleMute(newMuted);
  };

  const handleToggleVideo = () => {
    const newVideoOn = !isVideoOn;
    setIsVideoOn(newVideoOn);
    wsClient.toggleVideo(newVideoOn);
  };

  // Not optimistic: the server may refuse (sharing disabled, someone else
  // presenting). Local state follows its participant-update.
  const handleToggleScreenShare = () => {
    if (isScreenSharing) {
      wsClient.stopScreenShare();
    } else {
      wsClient.startScreenShare();
    }
  };

  const handleToggleHand = () => {
    const newRaised = !isHandRaised;
    setIsHandRaised(newRaised);
    wsClient.raiseHand(newRaised);
  };

  const handleEndForAll = () => {
    if (window.confirm('End this meeting for everyone?')) wsClient.endMeeting();
  };

  return (
    <div className="bg-zoom-controlbar border-t border-zoom-card px-6 py-3 flex items-center justify-between">
      {/* Left: Meeting info */}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-zoom-secondary font-mono">{meeting?.meetingCode || ''}</span>
        {locked && <span className="text-yellow-500 text-xs font-medium">Locked</span>}
      </div>

      {/* Center: Media controls */}
      <div className="flex items-center gap-3">
        {/* Mute */}
        <button
          onClick={handleToggleMute}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
            isMuted ? 'bg-zoom-red hover:bg-red-700' : 'bg-zinc-700 hover:bg-zinc-600'
          }`}
          title={isMuted ? 'Unmute' : 'Mute'}
        >
          {isMuted ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
              <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
              <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z" />
            </svg>
          )}
        </button>

        {/* Video */}
        <button
          onClick={handleToggleVideo}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
            !isVideoOn ? 'bg-zoom-red hover:bg-red-700' : 'bg-zinc-700 hover:bg-zinc-600'
          }`}
          title={isVideoOn ? 'Turn off camera' : 'Turn on camera'}
        >
          {isVideoOn ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
              <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
              <path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z" />
            </svg>
          )}
        </button>

        {/* Screen Share */}
        <button
          onClick={handleToggleScreenShare}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
            isScreenSharing ? 'bg-zoom-green hover:bg-green-700' : 'bg-zinc-700 hover:bg-zinc-600'
          }`}
          title={isScreenSharing ? 'Stop sharing' : 'Share screen'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
            <path d="M20 18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z" />
          </svg>
        </button>

        {/* Raise Hand */}
        <button
          onClick={handleToggleHand}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
            isHandRaised ? 'bg-yellow-500 hover:bg-yellow-600' : 'bg-zinc-700 hover:bg-zinc-600'
          }`}
          title={isHandRaised ? 'Lower hand' : 'Raise hand'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
            <path d="M21 7c0-1.38-1.12-2.5-2.5-2.5-.17 0-.34.02-.5.05V4c0-1.38-1.12-2.5-2.5-2.5-.23 0-.46.03-.67.09C14.46.66 13.56 0 12.5 0c-1.23 0-2.25.89-2.46 2.06C9.87 2.02 9.69 2 9.5 2 8.12 2 7 3.12 7 4.5v5.89c-.34-.31-.76-.51-1.22-.51-.73 0-1.38.45-1.64 1.12l-1.89 4.77C2.09 16.26 2 16.76 2 17.27V20c0 2.21 1.79 4 4 4h9c1.71 0 3.23-1.07 3.82-2.67l2.98-8.04C21.93 13.05 22 12.78 22 12.5V9c0-1.38-1.12-2.5-2.5-2.5-.17 0-.34.02-.5.05V7z" />
          </svg>
        </button>

        {/* Separator */}
        <div className="w-px h-8 bg-zinc-600 mx-1" />

        {/* Chat */}
        <button
          onClick={toggleChat}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
            isChatOpen ? 'bg-zoom-primary' : 'bg-zinc-700 hover:bg-zinc-600'
          }`}
          title="Chat"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
          </svg>
        </button>

        {/* Participants */}
        <button
          onClick={toggleParticipantList}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors relative ${
            isParticipantListOpen ? 'bg-zoom-primary' : 'bg-zinc-700 hover:bg-zinc-600'
          }`}
          title="Participants"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
            <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
          </svg>
          <span className="absolute -top-1 -right-1 bg-zoom-primary text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">
            {participants.length}
          </span>
          {isManager && waiting.length > 0 && (
            <span
              className="absolute -bottom-1 -right-1 bg-yellow-500 text-black text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center"
              title={`${waiting.length} waiting`}
            >
              {waiting.length}
            </span>
          )}
        </button>

        {/* Lock meeting (host / co-host) */}
        {isManager && (
          <button
            onClick={() => wsClient.lockMeeting(!locked)}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
              locked ? 'bg-yellow-500 hover:bg-yellow-600' : 'bg-zinc-700 hover:bg-zinc-600'
            }`}
            title={locked ? 'Unlock meeting' : 'Lock meeting'}
            aria-pressed={locked}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
              <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
            </svg>
          </button>
        )}

        {/* Breakout Rooms (host / co-host) */}
        {isManager && (
          <button
            onClick={toggleBreakout}
            className="w-10 h-10 rounded-full flex items-center justify-center bg-zinc-700 hover:bg-zinc-600 transition-colors"
            title="Breakout Rooms"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
              <path d="M3 3h8v8H3V3zm0 10h8v8H3v-8zm10-10h8v8h-8V3zm0 10h8v8h-8v-8z" />
            </svg>
          </button>
        )}
      </div>

      {/* Right: Leave (and End for all, host only) */}
      <div className="flex items-center gap-2">
        {isHost && (
          <button
            onClick={handleEndForAll}
            className="border border-zoom-red text-zoom-red hover:bg-zoom-red hover:text-white px-4 py-2 rounded-lg font-medium transition-colors"
          >
            End for all
          </button>
        )}
        <button
          onClick={onLeave}
          className="bg-zoom-red hover:bg-red-700 text-white px-6 py-2 rounded-lg font-medium transition-colors"
          title={isHost ? 'Leave; host passes to a co-host or the longest-present participant' : 'Leave'}
        >
          Leave
        </button>
      </div>
    </div>
  );
}
