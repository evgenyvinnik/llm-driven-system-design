import type { TypingUser } from '@/types';

/**
 * Props for the TypingIndicator component.
 */
interface TypingIndicatorProps {
  /** List of users currently typing in the conversation */
  users: TypingUser[];
}

/**
 * Displays an animated typing indicator showing which users are typing.
 * Shows individual names for 1-2 users, or "X people are typing" for more.
 * Features animated bouncing dots typical of messaging apps.
 *
 * @param props - Component props with typing users
 * @returns React component for typing indicator
 */
export function TypingIndicator({ users }: TypingIndicatorProps) {
  /**
   * Generates human-readable text for who is typing.
   *
   * @returns Descriptive text like "Alice is typing" or "3 people are typing"
   */
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
