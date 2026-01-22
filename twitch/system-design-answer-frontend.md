# Twitch - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## 1. Requirements Clarification (3 minutes)

### Functional Requirements
- **Live video player** with HLS playback, quality switching, low-latency mode
- **Real-time chat** with WebSocket, emotes, badges, moderation indicators
- **Channel browsing** with categories, live status, viewer counts
- **Creator dashboard** for stream management, analytics, chat settings
- **Follow/subscribe UI** with real-time status updates

### Non-Functional Requirements
- **Low-latency playback**: 2-5 second glass-to-glass latency
- **Chat responsiveness**: Messages appear within 100ms of send
- **Smooth video**: No buffering on stable connections
- **Accessibility**: Screen reader support, keyboard navigation
- **Mobile-responsive**: Full functionality on mobile devices

### UI/UX Priorities
1. Video player dominates viewport with theater/fullscreen modes
2. Chat is always visible but resizable/collapsible
3. Emotes render inline with text seamlessly
4. Live indicators pulse to show active streams

---

## 2. High-Level Architecture (5 minutes)

### Component Hierarchy

```
App
├── Header
│   ├── Logo
│   ├── SearchBar (with autocomplete)
│   ├── CategoryNav
│   └── UserMenu (login/profile)
├── Routes
│   ├── BrowsePage
│   │   ├── CategoryGrid
│   │   └── StreamCard (virtualized list)
│   ├── ChannelPage
│   │   ├── VideoPlayer
│   │   ├── ChatPanel
│   │   ├── ChannelInfo
│   │   └── StreamActions (follow/subscribe)
│   └── DashboardPage
│       ├── StreamControls
│       ├── ChatSettings
│       └── StreamKeyManager
└── GlobalModals
    ├── SubscribeModal
    ├── EmotePickerModal
    └── SettingsModal
```

### State Management Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Zustand Stores                       │
├─────────────────────────────────────────────────────────┤
│  AuthStore          │  ChatStore           │ PlayerStore │
│  - user             │  - messages[]        │ - quality   │
│  - session          │  - emotes            │ - volume    │
│  - follows          │  - badges            │ - latency   │
│  - subscriptions    │  - slowMode          │ - isPlaying │
├─────────────────────────────────────────────────────────┤
│                    WebSocket Layer                       │
│  - Chat connection per channel                          │
│  - Reconnection with exponential backoff                │
│  - Message queuing during disconnection                 │
└─────────────────────────────────────────────────────────┘
```

---

## 3. Video Player Component (10 minutes)

### HLS.js Integration

```typescript
// components/VideoPlayer/VideoPlayer.tsx
import Hls from 'hls.js';
import { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '@/stores/playerStore';

interface VideoPlayerProps {
  streamUrl: string;  // HLS manifest URL
  channelId: string;
  isLive: boolean;
}

export function VideoPlayer({ streamUrl, channelId, isLive }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const { quality, setQuality, setAvailableQualities, lowLatency } = usePlayerStore();
  const [isBuffering, setIsBuffering] = useState(false);
  const [currentLatency, setCurrentLatency] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl) return;

    if (Hls.isSupported()) {
      const hls = new Hls({
        // Low-latency HLS configuration
        enableWorker: true,
        lowLatencyMode: lowLatency,
        backBufferLength: 90,
        // Reduce buffer for lower latency
        liveSyncDuration: lowLatency ? 2 : 4,
        liveMaxLatencyDuration: lowLatency ? 5 : 10,
        liveDurationInfinity: true,
        // Faster quality switching
        abrEwmaDefaultEstimate: 500000,
      });

      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        // Extract available quality levels
        const qualities = data.levels.map((level, index) => ({
          index,
          height: level.height,
          bitrate: level.bitrate,
          label: `${level.height}p`,
        }));
        setAvailableQualities(qualities);
        video.play().catch(console.error);
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        setQuality(data.level);
      });

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        // Calculate live edge latency
        if (video.duration && isLive) {
          const latency = video.duration - video.currentTime;
          setCurrentLatency(latency);
        }
      });

      hlsRef.current = hls;

      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      video.src = streamUrl;
      video.play().catch(console.error);
    }
  }, [streamUrl, lowLatency]);

  // Manual quality switching
  const handleQualityChange = (levelIndex: number) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = levelIndex;  // -1 for auto
    }
  };

  // Jump to live edge
  const jumpToLive = () => {
    const video = videoRef.current;
    if (video && hlsRef.current) {
      video.currentTime = video.duration - 1;
    }
  };

  return (
    <div className="video-player-container">
      <video
        ref={videoRef}
        className="video-element"
        playsInline
        onWaiting={() => setIsBuffering(true)}
        onPlaying={() => setIsBuffering(false)}
      />

      {isBuffering && <BufferingOverlay />}

      <PlayerControls
        onQualityChange={handleQualityChange}
        onJumpToLive={jumpToLive}
        currentLatency={currentLatency}
        isLive={isLive}
      />
    </div>
  );
}
```

### Player Controls with Quality Selector

```typescript
// components/VideoPlayer/PlayerControls.tsx
interface PlayerControlsProps {
  onQualityChange: (level: number) => void;
  onJumpToLive: () => void;
  currentLatency: number;
  isLive: boolean;
}

export function PlayerControls({
  onQualityChange,
  onJumpToLive,
  currentLatency,
  isLive,
}: PlayerControlsProps) {
  const { volume, setVolume, isFullscreen, toggleFullscreen, availableQualities, quality } =
    usePlayerStore();
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="player-controls">
      <div className="controls-left">
        <PlayPauseButton />
        <VolumeSlider value={volume} onChange={setVolume} />

        {isLive && currentLatency > 5 && (
          <button onClick={onJumpToLive} className="live-button behind">
            <span className="live-dot" />
            {currentLatency.toFixed(1)}s behind
          </button>
        )}

        {isLive && currentLatency <= 5 && (
          <span className="live-button">
            <span className="live-dot pulse" />
            LIVE
          </span>
        )}
      </div>

      <div className="controls-right">
        <button onClick={() => setShowSettings(!showSettings)}>
          <SettingsIcon />
        </button>

        {showSettings && (
          <QualityMenu
            qualities={availableQualities}
            currentQuality={quality}
            onSelect={(level) => {
              onQualityChange(level);
              setShowSettings(false);
            }}
          />
        )}

        <button onClick={toggleFullscreen}>
          {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
        </button>
      </div>
    </div>
  );
}
```

### CSS for Player Layout

```css
/* Theater mode with collapsible chat */
.channel-page {
  display: grid;
  grid-template-columns: 1fr 340px;
  grid-template-rows: auto 1fr;
  height: 100vh;
}

.channel-page.theater-mode {
  grid-template-columns: 1fr 340px;
  grid-template-rows: 1fr auto;
}

.channel-page.fullscreen {
  grid-template-columns: 1fr;
}

.video-player-container {
  position: relative;
  background: #000;
  aspect-ratio: 16 / 9;
}

.video-element {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.player-controls {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-between;
  padding: 12px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.8));
  opacity: 0;
  transition: opacity 0.2s;
}

.video-player-container:hover .player-controls {
  opacity: 1;
}

.live-button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  background: #eb0400;
  color: white;
}

.live-button.behind {
  background: #666;
  cursor: pointer;
}

.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: white;
}

.live-dot.pulse {
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
```

---

## 4. Chat Component System (10 minutes)

### WebSocket Chat Connection

```typescript
// hooks/useChatWebSocket.ts
import { useEffect, useRef, useCallback } from 'react';
import { useChatStore } from '@/stores/chatStore';

interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  content: string;
  badges: string[];
  emotes: EmotePosition[];
  timestamp: number;
}

export function useChatWebSocket(channelId: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number>();
  const reconnectAttempts = useRef(0);

  const { addMessage, setConnectionStatus, clearMessages } = useChatStore();

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(
      `${import.meta.env.VITE_WS_URL}/chat?channel=${channelId}`
    );

    ws.onopen = () => {
      setConnectionStatus('connected');
      reconnectAttempts.current = 0;

      // Join channel room
      ws.send(JSON.stringify({ type: 'join', channelId }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'message':
          addMessage(data.message);
          break;
        case 'user_banned':
          // Handle ban (hide messages from user)
          break;
        case 'clear_chat':
          clearMessages();
          break;
        case 'slow_mode':
          useChatStore.getState().setSlowMode(data.duration);
          break;
      }
    };

    ws.onclose = () => {
      setConnectionStatus('disconnected');
      wsRef.current = null;

      // Exponential backoff reconnection
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
      reconnectAttempts.current++;

      reconnectTimeoutRef.current = window.setTimeout(connect, delay);
    };

    ws.onerror = () => {
      setConnectionStatus('error');
    };

    wsRef.current = ws;
  }, [channelId, addMessage, setConnectionStatus, clearMessages]);

  const sendMessage = useCallback((content: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'message',
        content,
        channelId,
      }));
    }
  }, [channelId]);

  useEffect(() => {
    connect();

    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { sendMessage };
}
```

### Chat Message List with Virtualization

```typescript
// components/Chat/ChatMessages.tsx
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useEffect } from 'react';
import { useChatStore } from '@/stores/chatStore';

export function ChatMessages() {
  const parentRef = useRef<HTMLDivElement>(null);
  const messages = useChatStore((s) => s.messages);
  const [isAutoScroll, setIsAutoScroll] = useState(true);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,  // Estimated message height
    overscan: 20,  // Render extra messages for smooth scrolling
  });

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (isAutoScroll && messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
    }
  }, [messages.length, isAutoScroll, virtualizer]);

  // Detect manual scroll to disable auto-scroll
  const handleScroll = () => {
    const element = parentRef.current;
    if (!element) return;

    const isAtBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 50;
    setIsAutoScroll(isAtBottom);
  };

  return (
    <div className="chat-messages-container">
      <div
        ref={parentRef}
        className="chat-scroll-area"
        onScroll={handleScroll}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
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
              <ChatMessage message={messages[virtualItem.index]} />
            </div>
          ))}
        </div>
      </div>

      {!isAutoScroll && (
        <button
          className="scroll-to-bottom"
          onClick={() => {
            virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
            setIsAutoScroll(true);
          }}
        >
          More messages below
        </button>
      )}
    </div>
  );
}
```

### Emote Rendering System

```typescript
// components/Chat/ChatMessage.tsx
import { useMemo } from 'react';
import { useEmoteStore } from '@/stores/emoteStore';

interface ChatMessageProps {
  message: {
    id: string;
    username: string;
    content: string;
    badges: string[];
    emotes: EmotePosition[];
    color: string;
  };
}

export function ChatMessage({ message }: ChatMessageProps) {
  const globalEmotes = useEmoteStore((s) => s.globalEmotes);
  const channelEmotes = useEmoteStore((s) => s.channelEmotes);

  // Parse message content and replace emotes with images
  const renderedContent = useMemo(() => {
    const parts: (string | JSX.Element)[] = [];
    let lastIndex = 0;

    // Sort emotes by start position
    const sortedEmotes = [...message.emotes].sort((a, b) => a.start - b.start);

    sortedEmotes.forEach((emote, idx) => {
      // Add text before emote
      if (emote.start > lastIndex) {
        parts.push(message.content.slice(lastIndex, emote.start));
      }

      // Add emote image
      const emoteData = globalEmotes[emote.id] || channelEmotes[emote.id];
      if (emoteData) {
        parts.push(
          <img
            key={`emote-${idx}`}
            src={emoteData.url}
            alt={emoteData.name}
            className="chat-emote"
            title={emoteData.name}
          />
        );
      } else {
        parts.push(message.content.slice(emote.start, emote.end + 1));
      }

      lastIndex = emote.end + 1;
    });

    // Add remaining text
    if (lastIndex < message.content.length) {
      parts.push(message.content.slice(lastIndex));
    }

    return parts.length > 0 ? parts : message.content;
  }, [message, globalEmotes, channelEmotes]);

  return (
    <div className="chat-message">
      <span className="badges">
        {message.badges.map((badge) => (
          <BadgeIcon key={badge} type={badge} />
        ))}
      </span>
      <span className="username" style={{ color: message.color }}>
        {message.username}
      </span>
      <span className="colon">: </span>
      <span className="content">{renderedContent}</span>
    </div>
  );
}

function BadgeIcon({ type }: { type: string }) {
  const badgeIcons: Record<string, string> = {
    broadcaster: '🎙️',
    moderator: '🗡️',
    vip: '💎',
    subscriber: '⭐',
    'subscriber-3': '⭐⭐⭐',
    'subscriber-6': '⭐⭐⭐⭐⭐⭐',
  };

  return (
    <span className="badge" title={type}>
      {badgeIcons[type] || ''}
    </span>
  );
}
```

### Chat Input with Emote Picker

```typescript
// components/Chat/ChatInput.tsx
import { useState, useRef } from 'react';
import { useChatStore } from '@/stores/chatStore';

interface ChatInputProps {
  onSend: (message: string) => void;
}

export function ChatInput({ onSend }: ChatInputProps) {
  const [message, setMessage] = useState('');
  const [showEmotePicker, setShowEmotePicker] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const slowMode = useChatStore((s) => s.slowMode);
  const cooldownRemaining = useChatStore((s) => s.cooldownRemaining);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim() && cooldownRemaining === 0) {
      onSend(message.trim());
      setMessage('');
    }
  };

  const insertEmote = (emoteName: string) => {
    setMessage((prev) => prev + (prev ? ' ' : '') + emoteName + ' ');
    inputRef.current?.focus();
    setShowEmotePicker(false);
  };

  return (
    <form onSubmit={handleSubmit} className="chat-input-form">
      <div className="input-wrapper">
        <input
          ref={inputRef}
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={
            cooldownRemaining > 0
              ? `Wait ${cooldownRemaining}s...`
              : 'Send a message'
          }
          disabled={cooldownRemaining > 0}
          maxLength={500}
        />

        <button
          type="button"
          onClick={() => setShowEmotePicker(!showEmotePicker)}
          className="emote-picker-button"
        >
          😀
        </button>
      </div>

      {showEmotePicker && (
        <EmotePicker onSelect={insertEmote} onClose={() => setShowEmotePicker(false)} />
      )}

      <div className="input-footer">
        {slowMode > 0 && (
          <span className="slow-mode-indicator">
            Slow mode: {slowMode}s
          </span>
        )}
        <button type="submit" disabled={!message.trim() || cooldownRemaining > 0}>
          Chat
        </button>
      </div>
    </form>
  );
}
```

---

## 5. Browse Page with Stream Cards (5 minutes)

### Virtualized Stream Grid

```typescript
// components/Browse/StreamGrid.tsx
import { useVirtualizer } from '@tanstack/react-virtual';

interface Stream {
  id: string;
  channelName: string;
  title: string;
  category: string;
  viewerCount: number;
  thumbnailUrl: string;
  isLive: boolean;
}

export function StreamGrid({ streams }: { streams: Stream[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(4);

  // Responsive column count
  useEffect(() => {
    const updateColumns = () => {
      const width = window.innerWidth;
      if (width < 640) setColumns(1);
      else if (width < 1024) setColumns(2);
      else if (width < 1280) setColumns(3);
      else setColumns(4);
    };

    updateColumns();
    window.addEventListener('resize', updateColumns);
    return () => window.removeEventListener('resize', updateColumns);
  }, []);

  const rowCount = Math.ceil(streams.length / columns);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 280,  // Card height + gap
    overscan: 2,
  });

  return (
    <div ref={parentRef} className="stream-grid-container">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const startIndex = virtualRow.index * columns;
          const rowStreams = streams.slice(startIndex, startIndex + columns);

          return (
            <div
              key={virtualRow.key}
              className="stream-row"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
                display: 'grid',
                gridTemplateColumns: `repeat(${columns}, 1fr)`,
                gap: '16px',
              }}
            >
              {rowStreams.map((stream) => (
                <StreamCard key={stream.id} stream={stream} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

### Stream Card with Live Preview

```typescript
// components/Browse/StreamCard.tsx
import { useState } from 'react';
import { Link } from '@tanstack/react-router';

export function StreamCard({ stream }: { stream: Stream }) {
  const [isHovering, setIsHovering] = useState(false);
  const [previewLoaded, setPreviewLoaded] = useState(false);

  return (
    <Link
      to="/channel/$channelName"
      params={{ channelName: stream.channelName }}
      className="stream-card"
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => {
        setIsHovering(false);
        setPreviewLoaded(false);
      }}
    >
      <div className="thumbnail-container">
        <img
          src={stream.thumbnailUrl}
          alt={stream.title}
          className="thumbnail"
        />

        {/* Live preview on hover */}
        {isHovering && (
          <video
            src={`/api/preview/${stream.id}`}
            className={`preview-video ${previewLoaded ? 'loaded' : ''}`}
            autoPlay
            muted
            loop
            onLoadedData={() => setPreviewLoaded(true)}
          />
        )}

        <div className="viewer-count">
          <span className="live-dot" />
          {formatViewerCount(stream.viewerCount)}
        </div>
      </div>

      <div className="stream-info">
        <div className="channel-avatar">
          <img src={`/avatars/${stream.channelName}`} alt="" />
        </div>
        <div className="stream-details">
          <h3 className="stream-title">{stream.title}</h3>
          <p className="channel-name">{stream.channelName}</p>
          <p className="category">{stream.category}</p>
        </div>
      </div>
    </Link>
  );
}

function formatViewerCount(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return count.toString();
}
```

---

## 6. Creator Dashboard (5 minutes)

### Stream Management Controls

```typescript
// routes/dashboard.tsx
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';

export function DashboardPage() {
  const { data: channel } = useQuery({
    queryKey: ['my-channel'],
    queryFn: () => api.getMyChannel(),
  });

  const [showStreamKey, setShowStreamKey] = useState(false);

  const startStreamMutation = useMutation({
    mutationFn: () => api.startStream(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['my-channel'] });
    },
  });

  const regenerateKeyMutation = useMutation({
    mutationFn: () => api.regenerateStreamKey(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['my-channel'] });
    },
  });

  return (
    <div className="dashboard">
      <h1>Creator Dashboard</h1>

      <section className="stream-section">
        <h2>Stream Settings</h2>

        <div className="stream-key-section">
          <label>Stream Key</label>
          <div className="stream-key-input">
            <input
              type={showStreamKey ? 'text' : 'password'}
              value={channel?.streamKey || ''}
              readOnly
            />
            <button onClick={() => setShowStreamKey(!showStreamKey)}>
              {showStreamKey ? 'Hide' : 'Show'}
            </button>
            <button
              onClick={() => navigator.clipboard.writeText(channel?.streamKey || '')}
            >
              Copy
            </button>
          </div>
          <button
            onClick={() => regenerateKeyMutation.mutate()}
            disabled={regenerateKeyMutation.isPending}
            className="regenerate-button"
          >
            Regenerate Key
          </button>
          <p className="warning">
            Warning: Regenerating will invalidate your current key
          </p>
        </div>

        <div className="stream-status">
          <span className={`status-indicator ${channel?.isLive ? 'live' : ''}`} />
          {channel?.isLive ? 'Currently Live' : 'Offline'}

          {channel?.isLive && (
            <span className="viewer-count">
              {channel.viewerCount} viewers
            </span>
          )}
        </div>

        {/* Simulated stream start for demo */}
        {!channel?.isLive && (
          <button
            onClick={() => startStreamMutation.mutate()}
            disabled={startStreamMutation.isPending}
            className="start-stream-button"
          >
            Start Stream (Simulated)
          </button>
        )}
      </section>

      <section className="chat-settings">
        <h2>Chat Settings</h2>
        <ChatModerationSettings channelId={channel?.id} />
      </section>
    </div>
  );
}
```

### Chat Moderation Settings

```typescript
// components/Dashboard/ChatModerationSettings.tsx
export function ChatModerationSettings({ channelId }: { channelId: string }) {
  const { data: settings } = useQuery({
    queryKey: ['chat-settings', channelId],
    queryFn: () => api.getChatSettings(channelId),
  });

  const updateSettings = useMutation({
    mutationFn: (newSettings: ChatSettings) =>
      api.updateChatSettings(channelId, newSettings),
  });

  return (
    <div className="chat-moderation-settings">
      <div className="setting-row">
        <label>
          <input
            type="checkbox"
            checked={settings?.slowMode > 0}
            onChange={(e) => updateSettings.mutate({
              ...settings,
              slowMode: e.target.checked ? 30 : 0,
            })}
          />
          Slow Mode
        </label>
        {settings?.slowMode > 0 && (
          <select
            value={settings.slowMode}
            onChange={(e) => updateSettings.mutate({
              ...settings,
              slowMode: parseInt(e.target.value),
            })}
          >
            <option value="5">5 seconds</option>
            <option value="10">10 seconds</option>
            <option value="30">30 seconds</option>
            <option value="60">60 seconds</option>
            <option value="120">2 minutes</option>
          </select>
        )}
      </div>

      <div className="setting-row">
        <label>
          <input
            type="checkbox"
            checked={settings?.subscriberOnly}
            onChange={(e) => updateSettings.mutate({
              ...settings,
              subscriberOnly: e.target.checked,
            })}
          />
          Subscriber-Only Chat
        </label>
      </div>

      <div className="setting-row">
        <label>
          <input
            type="checkbox"
            checked={settings?.followerOnly}
            onChange={(e) => updateSettings.mutate({
              ...settings,
              followerOnly: e.target.checked,
            })}
          />
          Follower-Only Chat
        </label>
        {settings?.followerOnly && (
          <select
            value={settings.followerMinutes || 0}
            onChange={(e) => updateSettings.mutate({
              ...settings,
              followerMinutes: parseInt(e.target.value),
            })}
          >
            <option value="0">No minimum</option>
            <option value="10">10 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60">1 hour</option>
            <option value="1440">1 day</option>
            <option value="10080">1 week</option>
          </select>
        )}
      </div>
    </div>
  );
}
```

---

## 7. Accessibility and Performance (4 minutes)

### Accessibility Features

```typescript
// Keyboard navigation for chat
function ChatPanel() {
  return (
    <div
      className="chat-panel"
      role="complementary"
      aria-label="Stream chat"
    >
      <div
        className="chat-messages"
        role="log"
        aria-live="polite"
        aria-atomic="false"
      >
        <ChatMessages />
      </div>

      <ChatInput />
    </div>
  );
}

// Screen reader announcements for live events
function useLiveAnnouncements(channelId: string) {
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    const ws = new WebSocket(`/ws/events/${channelId}`);

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'new_subscriber') {
        setAnnouncement(`${data.username} just subscribed!`);
      }
    };

    return () => ws.close();
  }, [channelId]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="sr-only"
    >
      {announcement}
    </div>
  );
}
```

### Performance Optimizations

```typescript
// Lazy load video player
const VideoPlayer = lazy(() => import('./VideoPlayer'));

// Memoize expensive chat message rendering
const ChatMessage = memo(function ChatMessage({ message }) {
  // ... component implementation
}, (prev, next) => prev.message.id === next.message.id);

// Debounce viewer count updates
function useViewerCount(channelId: string) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const interval = setInterval(async () => {
      const { viewerCount } = await api.getChannelStatus(channelId);
      setCount(viewerCount);
    }, 30000);  // Update every 30 seconds

    return () => clearInterval(interval);
  }, [channelId]);

  return count;
}
```

---

## 8. Summary (3 minutes)

### Key Frontend Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Video Player | HLS.js | Cross-browser HLS support, low-latency mode |
| Chat Virtualization | @tanstack/react-virtual | Handle 100K+ messages efficiently |
| State Management | Zustand | Simple, performant, TypeScript-friendly |
| WebSocket | Native + reconnection logic | Real-time chat with reliability |
| Emote Rendering | Inline parsing | Seamless emote/text mixing |

### Performance Metrics

- **First Contentful Paint**: < 1.5s
- **Time to Interactive**: < 3s
- **Video Start**: < 2s from click
- **Chat Message Latency**: < 100ms end-to-end

### Trade-offs Made

1. **HLS over WebRTC**: Higher latency (2-5s) but better scalability and CDN compatibility
2. **Virtualized chat**: More complex implementation but handles massive chat volumes
3. **Emote caching**: Pre-load emotes vs. lazy load - chose pre-load for instant rendering

### What Would Be Different at Scale

1. **Video Preview**: Hover previews via separate low-bitrate streams
2. **Emote CDN**: Third-party emote providers (BTTV, FFZ, 7TV) integration
3. **Chat Sharding**: Connect to regional chat servers for lower latency
4. **Clip Creation**: Client-side segment stitching with canvas recording
