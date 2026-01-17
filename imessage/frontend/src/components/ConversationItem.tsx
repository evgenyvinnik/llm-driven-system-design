import type { Conversation } from '@/types';
import { useAuthStore } from '@/stores/authStore';

/**
 * Props for the ConversationItem component.
 */
interface ConversationItemProps {
  /** The conversation to display */
  conversation: Conversation;
  /** Whether this conversation is currently selected */
  isSelected: boolean;
  /** Callback when the conversation is clicked */
  onClick: () => void;
}

/**
 * Renders a single conversation row in the conversation list.
 * Displays avatar, name, last message preview, timestamp, and unread count.
 * Highlights when selected with iMessage-style blue background.
 *
 * @param props - Component props
 * @returns React component for a conversation list item
 */
export function ConversationItem({ conversation, isSelected, onClick }: ConversationItemProps) {
  const user = useAuthStore((state) => state.user);

  /**
   * Gets the display name for the conversation.
   * For groups, uses group name. For direct chats, shows the other participant.
   *
   * @returns Display name string
   */
  const getDisplayName = () => {
    if (conversation.type === 'group') {
      return conversation.name || 'Group Chat';
    }
    const otherParticipant = conversation.participants?.find((p) => p.id !== user?.id);
    return otherParticipant?.display_name || otherParticipant?.username || 'Unknown';
  };

  /**
   * Extracts initials from a name for avatar placeholder.
   *
   * @param name - Full name to extract initials from
   * @returns Up to 2 uppercase initials
   */
  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  /**
   * Gets the avatar URL for display.
   * For groups, uses group avatar. For direct chats, uses the other participant's avatar.
   *
   * @returns Avatar URL or null if none set
   */
  const getAvatarUrl = () => {
    if (conversation.type === 'group') {
      return conversation.avatar_url;
    }
    const otherParticipant = conversation.participants?.find((p) => p.id !== user?.id);
    return otherParticipant?.avatar_url;
  };

  /**
   * Formats a timestamp for display in the conversation list.
   * Shows time for today, "Yesterday" for yesterday, weekday for last week,
   * and date for older messages.
   *
   * @param dateString - ISO date string to format
   * @returns Human-readable relative time string
   */
  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else if (diffDays < 7) {
      return date.toLocaleDateString([], { weekday: 'short' });
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  };

  const displayName = getDisplayName();
  const avatarUrl = getAvatarUrl();
  const lastMessage = conversation.last_message;

  return (
    <div
      onClick={onClick}
      className={`flex items-center px-4 py-3 cursor-pointer transition-colors ${
        isSelected ? 'bg-imessage-blue text-white' : 'hover:bg-gray-100'
      }`}
    >
      {/* Avatar */}
      <div
        className={`w-12 h-12 rounded-full flex items-center justify-center text-lg font-medium flex-shrink-0 ${
          isSelected ? 'bg-white text-imessage-blue' : 'bg-gray-200 text-gray-600'
        }`}
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={displayName}
            className="w-full h-full rounded-full object-cover"
          />
        ) : (
          getInitials(displayName)
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 ml-3">
        <div className="flex items-center justify-between">
          <span className={`font-semibold truncate ${isSelected ? 'text-white' : 'text-gray-900'}`}>
            {displayName}
          </span>
          {lastMessage && (
            <span
              className={`text-xs flex-shrink-0 ml-2 ${
                isSelected ? 'text-blue-100' : 'text-gray-500'
              }`}
            >
              {formatTime(lastMessage.created_at)}
            </span>
          )}
        </div>

        <div className="flex items-center mt-0.5">
          <p
            className={`text-sm truncate flex-1 ${
              isSelected ? 'text-blue-100' : 'text-gray-500'
            }`}
          >
            {lastMessage?.content || 'No messages yet'}
          </p>

          {conversation.unread_count > 0 && !isSelected && (
            <span className="ml-2 bg-imessage-blue text-white text-xs font-medium px-2 py-0.5 rounded-full">
              {conversation.unread_count}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
