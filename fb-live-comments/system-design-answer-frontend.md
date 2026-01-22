# Facebook Live Comments - System Design Answer (Frontend Focus)

## 45-minute system design interview format - Frontend Engineer Position

## Introduction

"Today I'll design a real-time commenting system for live video streams, similar to Facebook Live or YouTube Live. The core frontend challenge is rendering thousands of comments per second smoothly while maintaining 60fps, handling WebSocket reconnection gracefully, and creating engaging reaction animations. This involves interesting problems around virtualization, state management, and real-time UI updates."

---

## Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm what we're building on the frontend:

1. **Comment Stream Display**: Real-time scrolling comment feed overlaid on video
2. **Comment Composition**: Input for posting comments with character limits
3. **Floating Reactions**: Animated emoji reactions floating up the screen
4. **Live Viewer Count**: Real-time viewer count display
5. **Moderation UI**: Creator/moderator controls for pinning, hiding, banning
6. **Connection Status**: Visual feedback for WebSocket connection state

Should I also design the video player, or focus on comments?"

### Non-Functional Requirements

"For a live comments frontend:

- **Performance**: Maintain 60fps with 10,000+ comments per minute
- **Responsiveness**: Support mobile, tablet, and desktop layouts
- **Accessibility**: ARIA labels, keyboard navigation, screen reader support
- **Offline Resilience**: Queue comments when disconnected, resend on reconnect
- **Bundle Size**: Keep comment component under 50KB gzipped"

---

## Step 2: Component Architecture

```
+---------------------------------------------------------------------+
|                         LiveStreamPage                               |
+---------------------------------------------------------------------+
|                                                                      |
|  +------------------------------+  +------------------------------+  |
|  |       VideoPlayer            |  |      CommentPanel            |  |
|  |  +------------------------+  |  |  +------------------------+  |  |
|  |  |     ReactionsOverlay   |  |  |  |    CommentList         |  |  |
|  |  |  (floating animations) |  |  |  |  (virtualized scroll)  |  |  |
|  |  +------------------------+  |  |  +------------------------+  |  |
|  |                              |  |  +------------------------+  |  |
|  |  +------------------------+  |  |  |    CommentInput        |  |  |
|  |  |     ViewerCount        |  |  |  |  (compose + submit)    |  |  |
|  |  +------------------------+  |  |  +------------------------+  |  |
|  +------------------------------+  +------------------------------+  |
|                                                                      |
+---------------------------------------------------------------------+
```

---

## Step 3: State Management with Zustand

### Live Stream Store

```typescript
import { create } from 'zustand';

interface Comment {
  id: string;
  userId: string;
  username: string;
  avatarUrl: string;
  content: string;
  isHighlighted: boolean;
  isPinned: boolean;
  createdAt: number;
}

interface ReactionBurst {
  type: 'like' | 'love' | 'haha' | 'wow' | 'sad' | 'angry';
  count: number;
  timestamp: number;
}

interface ConnectionState {
  status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
  lastConnected: number | null;
  reconnectAttempt: number;
}

interface LiveStreamState {
  // Stream data
  streamId: string | null;
  viewerCount: number;

  // Comments
  comments: Comment[];
  pinnedComment: Comment | null;
  pendingComments: Comment[]; // Queued while offline

  // Reactions
  reactionQueue: ReactionBurst[];

  // Connection
  connection: ConnectionState;

  // Actions
  setStreamId: (id: string) => void;
  addCommentBatch: (comments: Comment[]) => void;
  addPendingComment: (comment: Comment) => void;
  flushPendingComments: () => Comment[];
  setPinnedComment: (comment: Comment | null) => void;
  addReactionBurst: (burst: ReactionBurst) => void;
  consumeReactions: () => ReactionBurst[];
  setViewerCount: (count: number) => void;
  setConnectionStatus: (status: ConnectionState['status']) => void;
}

const MAX_VISIBLE_COMMENTS = 500;

export const useLiveStreamStore = create<LiveStreamState>((set, get) => ({
  streamId: null,
  viewerCount: 0,
  comments: [],
  pinnedComment: null,
  pendingComments: [],
  reactionQueue: [],
  connection: {
    status: 'disconnected',
    lastConnected: null,
    reconnectAttempt: 0,
  },

  setStreamId: (id) => set({ streamId: id }),

  addCommentBatch: (newComments) =>
    set((state) => {
      // Merge and dedupe by ID
      const existingIds = new Set(state.comments.map((c) => c.id));
      const uniqueNew = newComments.filter((c) => !existingIds.has(c.id));

      // Keep only last N comments for performance
      const merged = [...state.comments, ...uniqueNew];
      const trimmed = merged.slice(-MAX_VISIBLE_COMMENTS);

      return { comments: trimmed };
    }),

  addPendingComment: (comment) =>
    set((state) => ({
      pendingComments: [...state.pendingComments, comment],
    })),

  flushPendingComments: () => {
    const pending = get().pendingComments;
    set({ pendingComments: [] });
    return pending;
  },

  setPinnedComment: (comment) => set({ pinnedComment: comment }),

  addReactionBurst: (burst) =>
    set((state) => ({
      reactionQueue: [...state.reactionQueue, burst],
    })),

  consumeReactions: () => {
    const reactions = get().reactionQueue;
    set({ reactionQueue: [] });
    return reactions;
  },

  setViewerCount: (count) => set({ viewerCount: count }),

  setConnectionStatus: (status) =>
    set((state) => ({
      connection: {
        ...state.connection,
        status,
        lastConnected: status === 'connected' ? Date.now() : state.connection.lastConnected,
        reconnectAttempt: status === 'reconnecting'
          ? state.connection.reconnectAttempt + 1
          : 0,
      },
    })),
}));
```

---

## Step 4: WebSocket Hook

### useWebSocket with Reconnection

```typescript
import { useEffect, useRef, useCallback } from 'react';
import { useLiveStreamStore } from '../stores/liveStreamStore';

interface WebSocketMessage {
  type: 'comments_batch' | 'reactions_batch' | 'viewer_count' | 'error';
  payload: unknown;
}

export function useWebSocket(streamId: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const {
    addCommentBatch,
    addReactionBurst,
    setViewerCount,
    setConnectionStatus,
    flushPendingComments,
    connection,
  } = useLiveStreamStore();

  const connect = useCallback(() => {
    if (!streamId) return;

    setConnectionStatus('connecting');

    const ws = new WebSocket(`wss://api.example.com/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionStatus('connected');

      // Join stream
      ws.send(JSON.stringify({
        type: 'join_stream',
        payload: { stream_id: streamId },
      }));

      // Flush any pending comments
      const pending = flushPendingComments();
      pending.forEach((comment) => {
        ws.send(JSON.stringify({
          type: 'post_comment',
          payload: comment,
        }));
      });
    };

    ws.onmessage = (event) => {
      const message: WebSocketMessage = JSON.parse(event.data);

      switch (message.type) {
        case 'comments_batch':
          addCommentBatch(message.payload as Comment[]);
          break;
        case 'reactions_batch':
          addReactionBurst(message.payload as ReactionBurst);
          break;
        case 'viewer_count':
          setViewerCount((message.payload as { count: number }).count);
          break;
        case 'error':
          console.error('WebSocket error:', message.payload);
          break;
      }
    };

    ws.onclose = (event) => {
      if (event.code !== 1000) { // Abnormal close
        setConnectionStatus('reconnecting');
        scheduleReconnect();
      } else {
        setConnectionStatus('disconnected');
      }
    };

    ws.onerror = () => {
      setConnectionStatus('reconnecting');
    };
  }, [streamId, setConnectionStatus, addCommentBatch, addReactionBurst, setViewerCount, flushPendingComments]);

  const scheduleReconnect = useCallback(() => {
    const attempt = connection.reconnectAttempt;
    const delay = Math.min(1000 * Math.pow(2, attempt), 30000); // Exponential backoff, max 30s

    reconnectTimeoutRef.current = setTimeout(() => {
      connect();
    }, delay);
  }, [connection.reconnectAttempt, connect]);

  const sendComment = useCallback((content: string) => {
    const comment = {
      id: `pending-${Date.now()}`,
      content,
      createdAt: Date.now(),
    };

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'post_comment',
        payload: { stream_id: streamId, content },
      }));
    } else {
      // Queue for later
      useLiveStreamStore.getState().addPendingComment(comment);
    }
  }, [streamId]);

  const sendReaction = useCallback((reactionType: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'react',
        payload: { stream_id: streamId, reaction_type: reactionType },
      }));
    }
  }, [streamId]);

  useEffect(() => {
    connect();

    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close(1000);
    };
  }, [connect]);

  return {
    sendComment,
    sendReaction,
    connectionStatus: connection.status,
  };
}
```

---

## Step 5: Virtualized Comment List

### CommentList with react-virtual

```typescript
import { useRef, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useLiveStreamStore } from '../stores/liveStreamStore';
import { CommentItem } from './CommentItem';

export function CommentList() {
  const comments = useLiveStreamStore((state) => state.comments);
  const pinnedComment = useLiveStreamStore((state) => state.pinnedComment);
  const parentRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  const virtualizer = useVirtualizer({
    count: comments.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60, // Estimated comment height
    overscan: 5,
    getItemKey: (index) => comments[index].id,
  });

  // Auto-scroll to bottom when new comments arrive
  useEffect(() => {
    if (autoScrollRef.current && comments.length > 0) {
      virtualizer.scrollToIndex(comments.length - 1, { align: 'end' });
    }
  }, [comments.length, virtualizer]);

  // Detect manual scroll to pause auto-scroll
  const handleScroll = () => {
    const element = parentRef.current;
    if (!element) return;

    const isAtBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    autoScrollRef.current = isAtBottom;
  };

  return (
    <div className="comment-list-container">
      {/* Pinned comment sticky at top */}
      {pinnedComment && (
        <div className="pinned-comment">
          <CommentItem comment={pinnedComment} isPinned />
        </div>
      )}

      {/* Virtualized comment list */}
      <div
        ref={parentRef}
        onScroll={handleScroll}
        className="comment-scroll-container"
        style={{ height: '100%', overflow: 'auto' }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => (
            <div
              key={virtualItem.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <CommentItem comment={comments[virtualItem.index]} />
            </div>
          ))}
        </div>
      </div>

      {/* "New comments" indicator when scrolled up */}
      {!autoScrollRef.current && (
        <button
          className="new-comments-indicator"
          onClick={() => {
            autoScrollRef.current = true;
            virtualizer.scrollToIndex(comments.length - 1, { align: 'end' });
          }}
        >
          New comments
        </button>
      )}
    </div>
  );
}
```

### CommentItem Component

```typescript
import { memo } from 'react';
import { formatDistanceToNow } from 'date-fns';

interface CommentItemProps {
  comment: Comment;
  isPinned?: boolean;
}

export const CommentItem = memo(function CommentItem({
  comment,
  isPinned = false
}: CommentItemProps) {
  return (
    <div
      className={`comment-item ${isPinned ? 'comment-pinned' : ''} ${
        comment.isHighlighted ? 'comment-highlighted' : ''
      }`}
      role="listitem"
      aria-label={`Comment by ${comment.username}`}
    >
      <img
        src={comment.avatarUrl}
        alt=""
        className="comment-avatar"
        loading="lazy"
      />
      <div className="comment-content">
        <div className="comment-header">
          <span className="comment-username">{comment.username}</span>
          <span className="comment-time">
            {formatDistanceToNow(comment.createdAt, { addSuffix: true })}
          </span>
        </div>
        <p className="comment-text">{comment.content}</p>
      </div>
      {isPinned && (
        <span className="pin-badge" aria-label="Pinned comment">
          Pinned
        </span>
      )}
    </div>
  );
});
```

---

## Step 6: Floating Reactions Animation

### ReactionsOverlay Component

```typescript
import { useEffect, useRef, useState } from 'react';
import { useLiveStreamStore } from '../stores/liveStreamStore';

interface FloatingReaction {
  id: string;
  type: string;
  emoji: string;
  x: number;
  startTime: number;
}

const EMOJI_MAP: Record<string, string> = {
  like: '👍',
  love: '❤️',
  haha: '😂',
  wow: '😮',
  sad: '😢',
  angry: '😠',
};

const ANIMATION_DURATION = 2000; // ms
const MAX_VISIBLE_REACTIONS = 50;

export function ReactionsOverlay() {
  const [floatingReactions, setFloatingReactions] = useState<FloatingReaction[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number>();

  const consumeReactions = useLiveStreamStore((state) => state.consumeReactions);

  // Poll for new reaction bursts
  useEffect(() => {
    const interval = setInterval(() => {
      const bursts = consumeReactions();

      bursts.forEach((burst) => {
        // Sample reactions for performance
        const displayCount = Math.min(burst.count, 10);

        const newReactions: FloatingReaction[] = [];
        for (let i = 0; i < displayCount; i++) {
          newReactions.push({
            id: `${burst.timestamp}-${i}`,
            type: burst.type,
            emoji: EMOJI_MAP[burst.type] || '❤️',
            x: Math.random() * 80 + 10, // 10-90% horizontal position
            startTime: Date.now() + i * 50, // Stagger animations
          });
        }

        setFloatingReactions((prev) =>
          [...prev, ...newReactions].slice(-MAX_VISIBLE_REACTIONS)
        );
      });
    }, 100);

    return () => clearInterval(interval);
  }, [consumeReactions]);

  // Animation loop
  useEffect(() => {
    const animate = () => {
      const now = Date.now();

      setFloatingReactions((prev) =>
        prev.filter((r) => now - r.startTime < ANIMATION_DURATION)
      );

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="reactions-overlay"
      aria-hidden="true" // Decorative element
    >
      {floatingReactions.map((reaction) => {
        const elapsed = Date.now() - reaction.startTime;
        const progress = Math.min(elapsed / ANIMATION_DURATION, 1);

        return (
          <span
            key={reaction.id}
            className="floating-reaction"
            style={{
              left: `${reaction.x}%`,
              bottom: `${progress * 100}%`,
              opacity: 1 - progress,
              transform: `scale(${1 + progress * 0.5})`,
            }}
          >
            {reaction.emoji}
          </span>
        );
      })}
    </div>
  );
}
```

---

## Step 7: Comment Input with Rate Limiting

### CommentInput Component

```typescript
import { useState, useCallback, useRef } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

const MAX_COMMENT_LENGTH = 200;
const RATE_LIMIT_COOLDOWN = 6000; // 6 seconds between comments

export function CommentInput({ streamId }: { streamId: string }) {
  const [content, setContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const lastSubmitRef = useRef(0);

  const { sendComment, connectionStatus } = useWebSocket(streamId);

  // Cooldown timer
  useEffect(() => {
    if (cooldownRemaining > 0) {
      const timer = setTimeout(() => {
        setCooldownRemaining((prev) => Math.max(0, prev - 1000));
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [cooldownRemaining]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();

      const now = Date.now();
      const timeSinceLastSubmit = now - lastSubmitRef.current;

      if (timeSinceLastSubmit < RATE_LIMIT_COOLDOWN) {
        setCooldownRemaining(RATE_LIMIT_COOLDOWN - timeSinceLastSubmit);
        return;
      }

      if (!content.trim() || content.length > MAX_COMMENT_LENGTH) {
        return;
      }

      setIsSubmitting(true);
      sendComment(content.trim());
      setContent('');
      lastSubmitRef.current = now;
      setIsSubmitting(false);
    },
    [content, sendComment]
  );

  const isDisabled =
    connectionStatus !== 'connected' ||
    isSubmitting ||
    cooldownRemaining > 0;

  return (
    <form onSubmit={handleSubmit} className="comment-input-form">
      <div className="input-wrapper">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={
            connectionStatus === 'connected'
              ? 'Add a comment...'
              : 'Connecting...'
          }
          maxLength={MAX_COMMENT_LENGTH}
          disabled={isDisabled}
          aria-label="Comment input"
          rows={1}
        />
        <span className="char-count">
          {content.length}/{MAX_COMMENT_LENGTH}
        </span>
      </div>

      <button
        type="submit"
        disabled={isDisabled || !content.trim()}
        aria-label="Send comment"
      >
        {cooldownRemaining > 0
          ? `Wait ${Math.ceil(cooldownRemaining / 1000)}s`
          : 'Send'}
      </button>

      {connectionStatus === 'reconnecting' && (
        <span className="connection-warning">
          Reconnecting... Comments will be sent when connected.
        </span>
      )}
    </form>
  );
}
```

---

## Step 8: Connection Status Indicator

### ConnectionStatus Component

```typescript
import { useLiveStreamStore } from '../stores/liveStreamStore';

export function ConnectionStatus() {
  const connection = useLiveStreamStore((state) => state.connection);

  const statusConfig = {
    connecting: {
      label: 'Connecting...',
      color: 'var(--color-warning)',
      icon: '⟳',
    },
    connected: {
      label: 'Live',
      color: 'var(--color-success)',
      icon: '●',
    },
    disconnected: {
      label: 'Disconnected',
      color: 'var(--color-error)',
      icon: '○',
    },
    reconnecting: {
      label: `Reconnecting (${connection.reconnectAttempt})...`,
      color: 'var(--color-warning)',
      icon: '⟳',
    },
  };

  const config = statusConfig[connection.status];

  return (
    <div
      className="connection-status"
      role="status"
      aria-live="polite"
      style={{ color: config.color }}
    >
      <span className="status-icon">{config.icon}</span>
      <span className="status-label">{config.label}</span>
    </div>
  );
}
```

---

## Step 9: Reaction Picker

### ReactionPicker Component

```typescript
import { useState, useCallback } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

const REACTIONS = [
  { type: 'like', emoji: '👍', label: 'Like' },
  { type: 'love', emoji: '❤️', label: 'Love' },
  { type: 'haha', emoji: '😂', label: 'Haha' },
  { type: 'wow', emoji: '😮', label: 'Wow' },
  { type: 'sad', emoji: '😢', label: 'Sad' },
  { type: 'angry', emoji: '😠', label: 'Angry' },
];

export function ReactionPicker({ streamId }: { streamId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [lastReaction, setLastReaction] = useState<number>(0);
  const { sendReaction, connectionStatus } = useWebSocket(streamId);

  const handleReaction = useCallback(
    (type: string) => {
      const now = Date.now();
      // Rate limit: 1 reaction per second
      if (now - lastReaction < 1000) return;

      sendReaction(type);
      setLastReaction(now);
      setIsOpen(false);
    },
    [sendReaction, lastReaction]
  );

  return (
    <div className="reaction-picker">
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={connectionStatus !== 'connected'}
        aria-expanded={isOpen}
        aria-haspopup="true"
        aria-label="Add reaction"
      >
        ❤️
      </button>

      {isOpen && (
        <div
          className="reaction-menu"
          role="menu"
          aria-label="Reactions"
        >
          {REACTIONS.map((reaction) => (
            <button
              key={reaction.type}
              onClick={() => handleReaction(reaction.type)}
              role="menuitem"
              aria-label={reaction.label}
            >
              {reaction.emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## Step 10: CSS for Live Comments

### Comment Styling

```css
/* Comment List Container */
.comment-list-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: rgba(0, 0, 0, 0.6);
  border-radius: 8px;
}

.comment-scroll-container {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.3) transparent;
}

/* Individual Comment */
.comment-item {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  color: white;
  animation: slideIn 0.2s ease-out;
}

.comment-item.comment-highlighted {
  background: linear-gradient(90deg, rgba(255, 215, 0, 0.2), transparent);
  border-left: 2px solid gold;
}

.comment-item.comment-pinned {
  background: rgba(66, 133, 244, 0.2);
  border-left: 2px solid #4285f4;
}

.comment-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  flex-shrink: 0;
}

.comment-content {
  flex: 1;
  min-width: 0;
}

.comment-username {
  font-weight: 600;
  font-size: 13px;
  margin-right: 8px;
}

.comment-time {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
}

.comment-text {
  font-size: 14px;
  line-height: 1.4;
  word-wrap: break-word;
  margin: 2px 0 0;
}

/* Pinned Comment */
.pinned-comment {
  position: sticky;
  top: 0;
  z-index: 10;
  background: rgba(0, 0, 0, 0.9);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.pin-badge {
  font-size: 10px;
  background: #4285f4;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
}

/* New Comments Indicator */
.new-comments-indicator {
  position: absolute;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  background: #4285f4;
  color: white;
  padding: 8px 16px;
  border-radius: 20px;
  border: none;
  cursor: pointer;
  animation: bounce 0.5s ease;
}

/* Animations */
@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

### Floating Reactions CSS

```css
.reactions-overlay {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 100px;
  height: 100%;
  pointer-events: none;
  overflow: hidden;
}

.floating-reaction {
  position: absolute;
  font-size: 24px;
  transition: none;
  will-change: transform, opacity, bottom;
  animation: float 2s ease-out forwards;
}

@keyframes float {
  0% {
    opacity: 1;
    transform: scale(0.5) translateY(0);
  }
  50% {
    opacity: 0.8;
    transform: scale(1.2) translateY(-50vh);
  }
  100% {
    opacity: 0;
    transform: scale(1.5) translateY(-100vh);
  }
}

/* Add slight horizontal wobble */
.floating-reaction:nth-child(odd) {
  animation-name: floatLeft;
}

@keyframes floatLeft {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-10px); }
  75% { transform: translateX(10px); }
}
```

---

## Step 11: Responsive Design

### Mobile Layout Adjustments

```css
/* Mobile: Comments overlay video */
@media (max-width: 768px) {
  .live-stream-page {
    flex-direction: column;
  }

  .comment-panel {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 40%;
    background: linear-gradient(
      to top,
      rgba(0, 0, 0, 0.9) 0%,
      rgba(0, 0, 0, 0.6) 50%,
      transparent 100%
    );
  }

  .comment-list-container {
    background: transparent;
  }

  .comment-input-form {
    padding: 8px;
    background: rgba(0, 0, 0, 0.8);
  }

  .comment-input-form textarea {
    font-size: 16px; /* Prevent iOS zoom */
  }

  .reaction-picker {
    position: fixed;
    bottom: 60px;
    right: 16px;
  }
}

/* Desktop: Side panel layout */
@media (min-width: 769px) {
  .live-stream-page {
    display: grid;
    grid-template-columns: 1fr 350px;
    height: 100vh;
  }

  .video-container {
    position: relative;
  }

  .comment-panel {
    display: flex;
    flex-direction: column;
    border-left: 1px solid rgba(255, 255, 255, 0.1);
  }
}
```

---

## Step 12: Performance Optimizations

### Debounced Updates

```typescript
import { useMemo } from 'react';
import { useLiveStreamStore } from '../stores/liveStreamStore';

export function useVisibleComments() {
  const comments = useLiveStreamStore((state) => state.comments);

  // Memoize to prevent unnecessary re-renders
  return useMemo(() => {
    // Only compute visible range for rendering
    return comments.slice(-100);
  }, [comments]);
}
```

### Object Pool for Reactions

```typescript
class ReactionElementPool {
  private pool: HTMLElement[] = [];
  private container: HTMLElement;

  constructor(container: HTMLElement, initialSize: number = 50) {
    this.container = container;

    // Pre-create elements
    for (let i = 0; i < initialSize; i++) {
      this.pool.push(this.createElement());
    }
  }

  private createElement(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'floating-reaction';
    el.style.display = 'none';
    this.container.appendChild(el);
    return el;
  }

  acquire(): HTMLElement {
    const el = this.pool.pop() || this.createElement();
    el.style.display = '';
    return el;
  }

  release(el: HTMLElement): void {
    el.style.display = 'none';
    this.pool.push(el);
  }
}
```

---

## Step 13: Accessibility

### Screen Reader Announcements

```typescript
import { useEffect, useRef } from 'react';
import { useLiveStreamStore } from '../stores/liveStreamStore';

export function CommentAnnouncer() {
  const comments = useLiveStreamStore((state) => state.comments);
  const lastAnnouncedRef = useRef<string>('');
  const announcerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (comments.length === 0) return;

    const latest = comments[comments.length - 1];
    if (latest.id === lastAnnouncedRef.current) return;

    lastAnnouncedRef.current = latest.id;

    // Announce new comment to screen readers
    if (announcerRef.current) {
      announcerRef.current.textContent =
        `New comment from ${latest.username}: ${latest.content}`;
    }
  }, [comments]);

  return (
    <div
      ref={announcerRef}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    />
  );
}
```

---

## Step 14: Trade-offs and Alternatives

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| State Management | Zustand | Redux | Simpler API, less boilerplate for real-time state |
| Virtualization | @tanstack/react-virtual | react-window | Better dynamic height support, newer API |
| WebSocket Reconnection | Custom hook | socket.io-client | Lower bundle size, more control |
| Reaction Animations | CSS + JS hybrid | Lottie/Canvas | Lighter weight for simple emoji animations |
| Comment Rendering | CSS transforms | Canvas | DOM accessibility, easier styling |

---

## Summary

"To summarize the frontend architecture for Facebook Live Comments:

1. **State Management**: Zustand store for comments, reactions, and connection state
2. **WebSocket Hook**: Custom hook with exponential backoff reconnection and offline queueing
3. **Virtualized List**: TanStack Virtual for smooth scrolling with 500+ comments
4. **Floating Reactions**: CSS animations with object pooling for performance
5. **Rate Limiting**: Client-side cooldown to prevent excessive submissions
6. **Responsive Design**: Overlay on mobile, side panel on desktop
7. **Accessibility**: ARIA labels, screen reader announcements, keyboard navigation

The key frontend insights are:
- Virtualization is critical for smooth scrolling at high comment volumes
- Client-side rate limiting provides instant feedback before server rejection
- Connection state must be visible so users know when comments will actually send
- Reaction animations need object pooling to avoid DOM thrashing
- Auto-scroll should pause when user scrolls up to read older comments

What aspects would you like me to elaborate on?"
