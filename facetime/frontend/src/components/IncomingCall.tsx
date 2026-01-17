/**
 * IncomingCall Component
 *
 * Full-screen overlay displayed when receiving an incoming call.
 * Shows caller information with accept and decline buttons.
 * Features animated ring effect and gradient background.
 */

import { useStore } from '../stores/useStore';

/**
 * Props for the IncomingCall component.
 */
interface IncomingCallProps {
  /** Callback invoked when user accepts the call */
  onAnswer: () => void;
  /** Callback invoked when user declines the call */
  onDecline: () => void;
}

/**
 * Renders the incoming call screen with caller info and action buttons.
 *
 * @param props - Component props with answer/decline handlers
 * @returns Full-screen incoming call overlay or null if no caller
 */
export function IncomingCall({ onAnswer, onDecline }: IncomingCallProps) {
  const { callState } = useStore();
  const caller = callState.caller;

  if (!caller) return null;

  return (
    <div className="fixed inset-0 bg-black flex flex-col items-center justify-center z-50 animate-slide-up">
      {/* Background blur effect */}
      <div className="absolute inset-0 bg-gradient-to-b from-blue-900/50 to-purple-900/50" />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center">
        {/* Avatar */}
        <div className="w-32 h-32 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-4xl font-semibold text-white mb-6 animate-pulse-ring">
          {caller.avatar_url ? (
            <img
              src={caller.avatar_url}
              alt={caller.display_name}
              className="w-full h-full rounded-full object-cover"
            />
          ) : (
            caller.display_name.charAt(0).toUpperCase()
          )}
        </div>

        {/* Caller info */}
        <h2 className="text-3xl font-semibold text-white mb-2">
          {caller.display_name}
        </h2>
        <p className="text-lg text-gray-300 mb-2">
          {callState.callType === 'video' ? 'FaceTime Video' : 'FaceTime Audio'}
        </p>
        <p className="text-gray-400 animate-pulse">
          Incoming call...
        </p>

        {/* Call actions */}
        <div className="flex gap-16 mt-16">
          {/* Decline */}
          <div className="flex flex-col items-center">
            <button
              onClick={onDecline}
              className="w-20 h-20 rounded-full bg-facetime-red flex items-center justify-center hover:bg-red-500 transition-colors"
            >
              <svg className="w-10 h-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <span className="text-sm text-gray-300 mt-3">Decline</span>
          </div>

          {/* Accept */}
          <div className="flex flex-col items-center">
            <button
              onClick={onAnswer}
              className="w-20 h-20 rounded-full bg-facetime-green flex items-center justify-center hover:bg-green-400 transition-colors"
            >
              <svg className="w-10 h-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
              </svg>
            </button>
            <span className="text-sm text-gray-300 mt-3">Accept</span>
          </div>
        </div>
      </div>
    </div>
  );
}
