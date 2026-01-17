/**
 * CallControls Component
 *
 * Provides in-call control buttons for muting audio, toggling video,
 * and ending the call. Displays current state with visual feedback.
 */

import { useStore } from '../stores/useStore';

/**
 * Props for the CallControls component.
 */
interface CallControlsProps {
  /** Callback invoked when user clicks the end call button */
  onEndCall: () => void;
}

/**
 * Renders call control buttons with current mute/video state.
 *
 * @param props - Component props containing end call handler
 * @returns Control bar with mute, end call, and video toggle buttons
 */
export function CallControls({ onEndCall }: CallControlsProps) {
  const { isMuted, isVideoOff, toggleMute, toggleVideo, callState } = useStore();

  return (
    <div className="flex items-center justify-center gap-6">
      {/* Mute button */}
      <button
        onClick={toggleMute}
        className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
          isMuted ? 'bg-white text-black' : 'bg-white/20 text-white hover:bg-white/30'
        }`}
        title={isMuted ? 'Unmute' : 'Mute'}
      >
        {isMuted ? (
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
          </svg>
        ) : (
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        )}
      </button>

      {/* End call button */}
      <button
        onClick={onEndCall}
        className="w-16 h-16 rounded-full bg-facetime-red flex items-center justify-center hover:bg-red-500 transition-colors"
        title="End call"
      >
        <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
        </svg>
      </button>

      {/* Video toggle button */}
      {callState.callType === 'video' && (
        <button
          onClick={toggleVideo}
          className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
            isVideoOff ? 'bg-white text-black' : 'bg-white/20 text-white hover:bg-white/30'
          }`}
          title={isVideoOff ? 'Turn video on' : 'Turn video off'}
        >
          {isVideoOff ? (
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3l18 18" />
            </svg>
          ) : (
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}
