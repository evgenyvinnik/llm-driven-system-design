/**
 * ActiveCall Component
 *
 * Full-screen view displayed during an active or connecting call.
 * Shows remote video as the main view with local video in picture-in-picture.
 * Displays call status, duration timer, and control buttons.
 */

import { useState, useEffect } from 'react';
import { useStore } from '../stores/useStore';
import { VideoPlayer } from './VideoPlayer';
import { CallControls } from './CallControls';

/**
 * Props for the ActiveCall component.
 */
interface ActiveCallProps {
  /** Callback invoked when user ends the call */
  onEndCall: () => void;
}

/**
 * Renders the active call screen with video streams and controls.
 *
 * @param props - Component props with end call handler
 * @returns Full-screen call view with local/remote video and controls
 */
export function ActiveCall({ onEndCall }: ActiveCallProps) {
  const { callState, localStream, remoteStream } = useStore();
  const [duration, setDuration] = useState(0);

  // Call timer
  useEffect(() => {
    if (callState.state !== 'connected' || !callState.startTime) return;

    const interval = setInterval(() => {
      setDuration(Math.floor((Date.now() - callState.startTime!) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [callState.state, callState.startTime]);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getStatusText = () => {
    switch (callState.state) {
      case 'initiating':
        return 'Starting call...';
      case 'ringing':
        return callState.direction === 'outgoing' ? 'Ringing...' : 'Incoming call';
      case 'connecting':
        return 'Connecting...';
      case 'connected':
        return formatDuration(duration);
      default:
        return '';
    }
  };

  const remoteName = callState.direction === 'outgoing'
    ? callState.callees[0]?.display_name || 'Unknown'
    : callState.caller?.display_name || 'Unknown';

  return (
    <div className="fixed inset-0 bg-black flex flex-col z-50">
      {/* Remote video (full screen) */}
      <div className="flex-1 relative">
        <VideoPlayer
          stream={remoteStream}
          className="w-full h-full"
        />

        {/* Overlay with call info */}
        <div className="absolute top-0 left-0 right-0 p-6 bg-gradient-to-b from-black/50 to-transparent">
          <div className="flex items-center justify-center flex-col">
            <p className="text-lg text-white/80">{remoteName}</p>
            <p className="text-sm text-white/60">{getStatusText()}</p>
          </div>
        </div>

        {/* Local video (picture-in-picture) */}
        <div className="absolute bottom-24 right-4 w-36 h-48 rounded-2xl overflow-hidden shadow-2xl border-2 border-white/20">
          <VideoPlayer
            stream={localStream}
            muted
            mirror
            className="w-full h-full"
            label="You"
          />
        </div>
      </div>

      {/* Controls at bottom */}
      <div className="absolute bottom-0 left-0 right-0 p-8 bg-gradient-to-t from-black/80 to-transparent">
        <CallControls onEndCall={onEndCall} />
      </div>
    </div>
  );
}
