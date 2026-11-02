import { useState } from 'react';
import type { ThreadDetail } from '../types';
import { MessageCard } from './MessageCard';
import { useMailStore } from '../stores/mailStore';
import { messageApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';

interface ThreadViewProps {
  thread: ThreadDetail;
  onBack: () => void;
}

/** Renders a thread detail view with message cards, star/archive/trash actions, and reply form. */
export function ThreadView({ thread, onBack }: ThreadViewProps) {
  const { toggleStar, moveToTrash, archiveThread, fetchThread } = useMailStore();
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const me = useAuthStore((s) => s.user?.email?.toLowerCase());

  const lastMessage = thread.messages[thread.messages.length - 1];

  const handleReply = async () => {
    if (!replyText.trim() || !lastMessage) return;

    setIsSending(true);
    try {
      // Reply all: the sender plus everyone on To and CC, minus yourself. When
      // replying to your own message, it goes to that message's recipients.
      // (CC used to be dropped and your own address kept.) BCC is never copied.
      const lower = (email: string) => email.toLowerCase();
      const unique = (emails: string[]) =>
        emails.map(lower).filter((email, i, all) => email !== me && all.indexOf(email) === i);
      const to = unique([lastMessage.sender.email, ...lastMessage.to.map((r) => r.email)]);
      const cc = unique(lastMessage.cc.map((r) => r.email)).filter((email) => !to.includes(email));
      if (to.length === 0 && cc.length === 0) {
        setReplyError('There is no one else on this message to reply to.');
        return;
      }

      setReplyError(null);
      await messageApi.reply({
        threadId: thread.id,
        inReplyTo: lastMessage.id,
        to: to.length > 0 ? to : cc,
        cc: to.length > 0 ? cc : [],
        bodyText: replyText,
      });

      setReplyText('');
      setReplyOpen(false);
      fetchThread(thread.id);
    } catch (error) {
      setReplyError(error instanceof Error ? error.message : 'Reply failed');
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-4">
      {/* Header */}
      <div className="flex items-center gap-4 mb-4">
        <button
          onClick={onBack}
          className="p-2 rounded-full hover:bg-gmail-hover"
        >
          <svg width="20" height="20" viewBox="0 0 24 24">
            <path
              fill="#5F6368"
              d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"
            />
          </svg>
        </button>

        <div className="flex items-center gap-2">
          <button
            onClick={() => archiveThread(thread.id)}
            className="p-2 rounded-full hover:bg-gmail-hover"
            title="Archive"
          >
            <svg width="20" height="20" viewBox="0 0 24 24">
              <path
                fill="#5F6368"
                d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"
              />
            </svg>
          </button>
          <button
            onClick={() => moveToTrash(thread.id)}
            className="p-2 rounded-full hover:bg-gmail-hover"
            title="Delete"
          >
            <svg width="20" height="20" viewBox="0 0 24 24">
              <path
                fill="#5F6368"
                d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Subject */}
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-xl text-gmail-text">{thread.subject}</h1>
        {thread.labels
          .filter(
            (l) =>
              !l.isSystem ||
              (l.name !== 'INBOX' &&
                l.name !== 'SENT' &&
                l.name !== 'ALL_MAIL')
          )
          .map((label) => (
            <span
              key={label.id}
              className="text-xs px-2 py-0.5 rounded-sm"
              style={{
                backgroundColor: label.color + '20',
                color: label.color,
              }}
            >
              {label.name === 'STARRED'
                ? 'Starred'
                : label.isSystem
                  ? label.name.charAt(0) + label.name.slice(1).toLowerCase()
                  : label.name}
            </span>
          ))}
        <button
          onClick={() => toggleStar(thread.id)}
          className="ml-auto"
        >
          <svg width="20" height="20" viewBox="0 0 24 24">
            <path
              fill={thread.isStarred ? '#F4B400' : 'none'}
              stroke={thread.isStarred ? '#F4B400' : '#C4C7C5'}
              strokeWidth="2"
              d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
            />
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div className="space-y-4">
        {thread.messages.map((message, index) => (
          <MessageCard
            key={message.id}
            message={message}
            isLast={index === thread.messages.length - 1}
          />
        ))}
      </div>

      {/* Reply */}
      <div className="mt-6 border border-gmail-border rounded-lg bg-white">
        {!replyOpen ? (
          <button
            onClick={() => setReplyOpen(true)}
            className="w-full text-left px-6 py-4 text-sm text-gmail-text-secondary hover:bg-gmail-hover rounded-lg"
          >
            Click here to reply
          </button>
        ) : (
          <div className="p-4">
            <div className="text-xs text-gmail-text-secondary mb-2">
              Reply all to {lastMessage?.sender.displayName}
              {lastMessage && lastMessage.to.length + lastMessage.cc.length > 1 && ' and others'}
            </div>
            {replyError && (
              <div className="text-xs text-red-600 mb-2" role="alert">
                {replyError}
              </div>
            )}
            <textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Type your reply..."
              className="w-full border border-gmail-border rounded-md p-3 text-sm text-gmail-text min-h-[120px] focus:outline-none focus:border-gmail-blue resize-y"
              autoFocus
            />
            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={handleReply}
                disabled={isSending || !replyText.trim()}
                className="bg-gmail-blue text-white px-6 py-2 rounded-full text-sm hover:bg-gmail-blue-hover disabled:opacity-50"
              >
                {isSending ? 'Sending...' : 'Send'}
              </button>
              <button
                onClick={() => {
                  setReplyOpen(false);
                  setReplyText('');
                }}
                className="text-gmail-text-secondary text-sm hover:text-gmail-text px-3 py-2"
              >
                Discard
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
