import { Link, useNavigate } from '@tanstack/react-router';
import type { SwipeResult } from '../types';
import ReignsAvatar from './ReignsAvatar';

interface MatchModalProps {
  match: SwipeResult['match'];
  onClose: () => void;
}

export default function MatchModal({ match, onClose }: MatchModalProps) {
  const navigate = useNavigate();

  if (!match) return null;

  const handleSendMessage = () => {
    navigate({ to: '/chat/$matchId', params: { matchId: match.id } });
    onClose();
  };

  return (
    <div className="match-modal" onClick={onClose}>
      <div
        className="bg-white rounded-3xl p-8 max-w-sm w-full mx-4 text-center animate-match-pop"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-6">
          <div className="w-24 h-24 mx-auto mb-4 relative">
            <div className="absolute inset-0 bg-tinder-gradient rounded-full animate-ping opacity-30" />
            <div className="relative w-full h-full bg-tinder-gradient rounded-full flex items-center justify-center">
              <svg className="w-12 h-12 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
              </svg>
            </div>
          </div>
          <h2 className="text-3xl font-bold bg-tinder-gradient bg-clip-text text-transparent">
            It's a Match!
          </h2>
          <p className="text-gray-500 mt-2">
            You and {match.user.name} liked each other
          </p>
        </div>

        {/* Matched user photo */}
        <div className="mb-8">
          <div className="w-32 h-32 mx-auto rounded-full overflow-hidden border-4 border-gradient-start shadow-lg bg-gray-800">
            <ReignsAvatar
              seed={`${match.user.id}-${match.user.name}`}
              size={128}
            />
          </div>
          <p className="mt-3 font-semibold text-lg">{match.user.name}</p>
        </div>

        {/* Actions */}
        <div className="space-y-3">
          <button
            onClick={handleSendMessage}
            className="btn btn-primary w-full py-3 text-lg"
          >
            Send Message
          </button>
          <button
            onClick={onClose}
            className="btn btn-secondary w-full py-3"
          >
            Keep Swiping
          </button>
        </div>
      </div>
    </div>
  );
}
