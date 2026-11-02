import { useState } from 'react';
import type { Message } from '../types';
import { formatFullDate, getInitials, stringToColor } from '../utils/format';
import DOMPurify from 'dompurify';

/**
 * Message HTML is sanitized on the server when sent; this second pass covers
 * rows written before that (and anything inserted directly, like the seed).
 * Mail is written by other people, so its HTML is never trusted as-is.
 */
const safeHtml = (html: string): string =>
  DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input'], FORBID_ATTR: ['style'] });

interface MessageCardProps {
  message: Message;
  isLast: boolean;
}

/** Renders a single email message within a thread with expandable body and sender avatar. */
export function MessageCard({ message, isLast }: MessageCardProps) {
  const [expanded, setExpanded] = useState(isLast);

  const recipientSummary = message.to
    .map((r) => r.displayName || r.email)
    .join(', ');

  return (
    <div className="bg-white rounded-lg border border-gmail-border">
      {/* Header */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-start gap-3 px-6 py-4 cursor-pointer hover:bg-gray-50"
      >
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-medium flex-shrink-0 mt-0.5"
          style={{
            backgroundColor: stringToColor(message.sender.displayName),
          }}
        >
          {getInitials(message.sender.displayName)}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm text-gmail-text">
              {message.sender.displayName}
            </span>
            <span className="text-xs text-gmail-text-secondary">
              &lt;{message.sender.email}&gt;
            </span>
            <span className="text-xs text-gmail-text-secondary ml-auto flex-shrink-0">
              {formatFullDate(message.createdAt)}
            </span>
          </div>

          {!expanded && (
            <div className="text-sm text-gmail-text-secondary truncate mt-0.5">
              {message.bodyText.substring(0, 150)}
            </div>
          )}

          {expanded && (
            <div className="text-xs text-gmail-text-secondary mt-0.5">
              to {recipientSummary}
              {message.cc.length > 0 && (
                <span>
                  , cc: {message.cc.map((r) => r.displayName || r.email).join(', ')}
                </span>
              )}
              {message.bcc.length > 0 && (
                <span data-testid="bcc-line">
                  , bcc: {message.bcc.map((r) => r.displayName || r.email).join(', ')}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      {expanded && (
        <div className="px-6 pb-6 pl-[4.25rem]">
          {message.bodyHtml ? (
            <div
              className="text-sm text-gmail-text leading-relaxed prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: safeHtml(message.bodyHtml) }}
            />
          ) : (
            <div className="text-sm text-gmail-text leading-relaxed whitespace-pre-wrap">
              {message.bodyText}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
