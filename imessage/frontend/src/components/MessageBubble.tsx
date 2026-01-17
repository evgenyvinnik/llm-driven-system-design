import type { Message } from '@/types';

interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  showAvatar: boolean;
}

export function MessageBubble({ message, isOwn, showAvatar }: MessageBubbleProps) {
  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <div
      className={`flex message-animate ${isOwn ? 'justify-end' : 'justify-start'} mb-1`}
    >
      {!isOwn && showAvatar && (
        <div className="w-8 h-8 rounded-full bg-gray-300 flex items-center justify-center text-xs font-medium text-gray-600 mr-2 flex-shrink-0">
          {message.sender_avatar_url ? (
            <img
              src={message.sender_avatar_url}
              alt={message.sender_display_name}
              className="w-full h-full rounded-full object-cover"
            />
          ) : (
            getInitials(message.sender_display_name || message.sender_username)
          )}
        </div>
      )}

      {!isOwn && !showAvatar && <div className="w-8 mr-2 flex-shrink-0" />}

      <div className={`max-w-[70%] ${isOwn ? 'items-end' : 'items-start'}`}>
        {!isOwn && showAvatar && (
          <span className="text-xs text-gray-500 ml-1 mb-0.5 block">
            {message.sender_display_name || message.sender_username}
          </span>
        )}

        <div
          className={`px-4 py-2 rounded-2xl ${
            isOwn
              ? 'bg-imessage-blue text-white rounded-br-md'
              : 'bg-gray-200 text-gray-900 rounded-bl-md'
          }`}
        >
          {message.reply_to && (
            <div
              className={`text-xs mb-1 pb-1 border-b ${
                isOwn ? 'border-blue-400 text-blue-100' : 'border-gray-300 text-gray-500'
              }`}
            >
              Replying to: {message.reply_to.content.slice(0, 30)}
              {message.reply_to.content.length > 30 ? '...' : ''}
            </div>
          )}

          <p className="break-words whitespace-pre-wrap">{message.content}</p>

          {message.edited_at && (
            <span
              className={`text-xs ${isOwn ? 'text-blue-200' : 'text-gray-400'}`}
            >
              (edited)
            </span>
          )}
        </div>

        <div
          className={`flex items-center mt-0.5 space-x-1 ${
            isOwn ? 'justify-end' : 'justify-start'
          }`}
        >
          <span className="text-xs text-gray-400">{formatTime(message.created_at)}</span>

          {isOwn && message.status && (
            <span className="text-xs text-gray-400">
              {message.status === 'sending' && (
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                    fill="none"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
              )}
              {message.status === 'sent' && 'Sent'}
              {message.status === 'delivered' && 'Delivered'}
              {message.status === 'read' && 'Read'}
            </span>
          )}
        </div>

        {/* Reactions */}
        {message.reactions && message.reactions.length > 0 && (
          <div
            className={`flex flex-wrap gap-1 mt-1 ${
              isOwn ? 'justify-end' : 'justify-start'
            }`}
          >
            {Array.from(
              message.reactions.reduce((acc, r) => {
                acc.set(r.reaction, (acc.get(r.reaction) || 0) + 1);
                return acc;
              }, new Map<string, number>())
            ).map(([reaction, count]) => (
              <span
                key={reaction}
                className="text-sm bg-gray-100 rounded-full px-2 py-0.5"
              >
                {reaction} {count > 1 && count}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
