import type { TypingUser } from '@/types';

interface TypingIndicatorProps {
  users: TypingUser[];
}

export function TypingIndicator({ users }: TypingIndicatorProps) {
  const getTypingText = () => {
    if (users.length === 1) {
      return `${users[0].displayName || users[0].username} is typing`;
    } else if (users.length === 2) {
      return `${users[0].displayName || users[0].username} and ${users[1].displayName || users[1].username} are typing`;
    } else {
      return `${users.length} people are typing`;
    }
  };

  return (
    <div className="flex items-center space-x-2 px-4 py-2">
      <div className="flex space-x-1">
        <div className="w-2 h-2 bg-gray-400 rounded-full typing-dot" />
        <div className="w-2 h-2 bg-gray-400 rounded-full typing-dot" />
        <div className="w-2 h-2 bg-gray-400 rounded-full typing-dot" />
      </div>
      <span className="text-sm text-gray-500">{getTypingText()}</span>
    </div>
  );
}
