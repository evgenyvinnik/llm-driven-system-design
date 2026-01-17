import type { Conversation } from '@/types';
import { useAuthStore } from '@/stores/authStore';

interface ConversationItemProps {
  conversation: Conversation;
  isSelected: boolean;
  onClick: () => void;
}

export function ConversationItem({ conversation, isSelected, onClick }: ConversationItemProps) {
  const user = useAuthStore((state) => state.user);

  const getDisplayName = () => {
    if (conversation.type === 'group') {
      return conversation.name || 'Group Chat';
    }
    const otherParticipant = conversation.participants?.find((p) => p.id !== user?.id);
    return otherParticipant?.display_name || otherParticipant?.username || 'Unknown';
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const getAvatarUrl = () => {
    if (conversation.type === 'group') {
      return conversation.avatar_url;
    }
    const otherParticipant = conversation.participants?.find((p) => p.id !== user?.id);
    return otherParticipant?.avatar_url;
  };

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
