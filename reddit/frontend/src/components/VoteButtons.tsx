import { useState } from 'react';
import api from '../services/api';

interface VoteButtonsProps {
  type: 'post' | 'comment';
  id: number;
  score: number;
  userVote?: number;
  vertical?: boolean;
}

export function VoteButtons({ type, id, score, userVote = 0, vertical = true }: VoteButtonsProps) {
  const [currentVote, setCurrentVote] = useState(userVote);
  const [currentScore, setCurrentScore] = useState(score);
  const [isVoting, setIsVoting] = useState(false);

  const handleVote = async (direction: 1 | -1) => {
    if (isVoting) return;

    const newDirection = currentVote === direction ? 0 : direction;
    setIsVoting(true);

    try {
      const result = await api.vote(type, id, newDirection);
      setCurrentVote(result.direction);
      setCurrentScore(result.score);
    } catch (error) {
      console.error('Vote failed:', error);
    } finally {
      setIsVoting(false);
    }
  };

  const containerClass = vertical
    ? 'flex flex-col items-center gap-1 mr-2'
    : 'flex items-center gap-2';

  return (
    <div className={containerClass}>
      <button
        onClick={() => handleVote(1)}
        disabled={isVoting}
        className={`p-1 rounded transition-colors ${
          currentVote === 1
            ? 'text-reddit-orange bg-orange-100'
            : 'text-gray-400 hover:text-reddit-orange hover:bg-orange-50'
        }`}
        aria-label="Upvote"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-6 w-6"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
        </svg>
      </button>

      <span
        className={`font-bold text-sm ${
          currentVote === 1
            ? 'text-reddit-orange'
            : currentVote === -1
            ? 'text-blue-600'
            : 'text-gray-700'
        }`}
      >
        {currentScore}
      </span>

      <button
        onClick={() => handleVote(-1)}
        disabled={isVoting}
        className={`p-1 rounded transition-colors ${
          currentVote === -1
            ? 'text-blue-600 bg-blue-100'
            : 'text-gray-400 hover:text-blue-600 hover:bg-blue-50'
        }`}
        aria-label="Downvote"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-6 w-6"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
    </div>
  );
}
