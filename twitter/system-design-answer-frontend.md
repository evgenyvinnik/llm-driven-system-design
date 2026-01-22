# Twitter - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## 1. Requirements Clarification (3 minutes)

### Functional Requirements
- **Timeline**: Infinite scroll feed of tweets from followed users
- **Tweet Composition**: 280-character limit with media attachments
- **Engagement**: Like, retweet, reply with optimistic updates
- **Profile**: User page with tweets, followers, following
- **Trending**: Real-time popular topics sidebar
- **Search**: Hashtag and user search

### Non-Functional Requirements
- **Performance**: < 100ms perceived timeline load
- **Responsiveness**: Mobile-first, desktop-enhanced
- **Accessibility**: Screen reader support, keyboard navigation
- **Real-time**: Updates without page refresh

### UI/UX Priorities
1. Content-first timeline with minimal chrome
2. Quick compose always accessible
3. Engagement actions visible but not intrusive
4. Trending topics contextually available

---

## 2. Component Architecture (5 minutes)

### Component Hierarchy

```
App
├── Header
│   ├── Logo
│   ├── SearchBar (autocomplete)
│   └── UserMenu (compose, profile, settings)
├── Layout (3-column on desktop)
│   ├── LeftSidebar
│   │   ├── NavLinks (Home, Explore, Notifications, Profile)
│   │   └── TweetButton
│   ├── MainContent
│   │   └── Routes
│   │       ├── HomeTimeline
│   │       ├── ExplorePage
│   │       ├── ProfilePage
│   │       └── TweetDetail
│   └── RightSidebar
│       ├── TrendingTopics
│       └── WhoToFollow
└── ComposeModal (global)
```

### State Management Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       Zustand Stores                             │
├─────────────────────────────────────────────────────────────────┤
│  AuthStore           │  TimelineStore        │  UIStore         │
│  - user              │  - tweets[]           │  - composeOpen   │
│  - isAuthenticated   │  - hasMore            │  - activeTab     │
│  - login/logout      │  - fetchTimeline()    │  - theme         │
├─────────────────────────────────────────────────────────────────┤
│  EngagementStore     │  TrendingStore        │                  │
│  - likes: Set        │  - trends[]           │                  │
│  - retweets: Set     │  - loading            │                  │
│  - toggleLike()      │  - fetchTrends()      │                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Timeline Component with Virtualization (10 minutes)

### Why Virtualization

Twitter timelines can have thousands of tweets. Without virtualization:
- 200 tweets = 1200+ DOM nodes
- Memory usage 150MB+
- Scroll jank after 50 tweets

With virtualization:
- ~80 DOM nodes regardless of list size
- Memory usage ~60MB
- Smooth scrolling throughout

### Virtualized Timeline Implementation

```typescript
// components/Timeline.tsx
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useEffect } from 'react';
import { useTimelineStore } from '@/stores/timelineStore';

interface TimelineProps {
  tweets: Tweet[];
  isLoading: boolean;
  onLoadMore: () => void;
  hasMore: boolean;
}

export function Timeline({ tweets, isLoading, onLoadMore, hasMore }: TimelineProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: tweets.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 150, // Average tweet height
    overscan: 5, // Extra items above/below viewport
    measureElement: (element) => element.getBoundingClientRect().height,
  });

  // Infinite scroll trigger
  useEffect(() => {
    const items = virtualizer.getVirtualItems();
    const lastItem = items[items.length - 1];

    if (!lastItem) return;

    if (lastItem.index >= tweets.length - 5 && hasMore && !isLoading) {
      onLoadMore();
    }
  }, [virtualizer.getVirtualItems(), hasMore, isLoading, tweets.length, onLoadMore]);

  return (
    <div ref={parentRef} className="timeline-scroll-container">
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
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualItem.start}px)`,
            }}
          >
            <Tweet tweet={tweets[virtualItem.index]} />
          </div>
        ))}
      </div>

      {isLoading && (
        <div className="loading-indicator">
          <Spinner />
        </div>
      )}
    </div>
  );
}
```

### Tweet Component

```typescript
// components/Tweet.tsx
import { memo } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { useEngagementStore } from '@/stores/engagementStore';

interface TweetProps {
  tweet: {
    id: string;
    author: { username: string; displayName: string; avatarUrl: string };
    content: string;
    createdAt: string;
    likeCount: number;
    retweetCount: number;
    replyCount: number;
  };
}

export const Tweet = memo(function Tweet({ tweet }: TweetProps) {
  const { likes, retweets, toggleLike, toggleRetweet } = useEngagementStore();

  const isLiked = likes.has(tweet.id);
  const isRetweeted = retweets.has(tweet.id);

  return (
    <article className="tweet">
      <div className="tweet-avatar">
        <img
          src={tweet.author.avatarUrl}
          alt={tweet.author.displayName}
          loading="lazy"
        />
      </div>

      <div className="tweet-content">
        <div className="tweet-header">
          <span className="display-name">{tweet.author.displayName}</span>
          <span className="username">@{tweet.author.username}</span>
          <span className="separator">·</span>
          <time className="timestamp">
            {formatDistanceToNow(new Date(tweet.createdAt), { addSuffix: true })}
          </time>
        </div>

        <p className="tweet-text">
          {parseContent(tweet.content)}
        </p>

        <div className="tweet-actions">
          <ActionButton
            icon={<ReplyIcon />}
            count={tweet.replyCount}
            label="Reply"
          />

          <ActionButton
            icon={<RetweetIcon />}
            count={tweet.retweetCount + (isRetweeted ? 1 : 0)}
            active={isRetweeted}
            activeColor="text-twitter-retweet"
            onClick={() => toggleRetweet(tweet.id)}
            label="Retweet"
          />

          <ActionButton
            icon={<HeartIcon filled={isLiked} />}
            count={tweet.likeCount + (isLiked ? 1 : 0)}
            active={isLiked}
            activeColor="text-twitter-like"
            onClick={() => toggleLike(tweet.id)}
            label="Like"
          />

          <ActionButton
            icon={<ShareIcon />}
            label="Share"
          />
        </div>
      </div>
    </article>
  );
}, (prevProps, nextProps) => prevProps.tweet.id === nextProps.tweet.id);
```

### Content Parsing with Hashtag Links

```typescript
// utils/parseContent.tsx
import { Link } from '@tanstack/react-router';

export function parseContent(content: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /(#\w+)|(@\w+)|(https?:\/\/\S+)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(content)) !== null) {
    // Add text before match
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }

    const [token] = match;

    if (token.startsWith('#')) {
      // Hashtag link
      parts.push(
        <Link
          key={match.index}
          to="/hashtag/$tag"
          params={{ tag: token.slice(1) }}
          className="text-twitter-blue hover:underline"
        >
          {token}
        </Link>
      );
    } else if (token.startsWith('@')) {
      // Mention link
      parts.push(
        <Link
          key={match.index}
          to="/profile/$username"
          params={{ username: token.slice(1) }}
          className="text-twitter-blue hover:underline"
        >
          {token}
        </Link>
      );
    } else {
      // URL link
      parts.push(
        <a
          key={match.index}
          href={token}
          target="_blank"
          rel="noopener noreferrer"
          className="text-twitter-blue hover:underline"
        >
          {truncateUrl(token)}
        </a>
      );
    }

    lastIndex = regex.lastIndex;
  }

  // Add remaining text
  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }

  return parts;
}
```

---

## 4. Optimistic Updates for Engagement (8 minutes)

### Engagement Store with Optimistic State

```typescript
// stores/engagementStore.ts
import { create } from 'zustand';
import { api } from '@/services/api';

interface EngagementState {
  likes: Set<string>;
  retweets: Set<string>;
  pendingLikes: Set<string>;
  pendingRetweets: Set<string>;

  toggleLike: (tweetId: string) => Promise<void>;
  toggleRetweet: (tweetId: string) => Promise<void>;
  initFromServer: (likedIds: string[], retweetedIds: string[]) => void;
}

export const useEngagementStore = create<EngagementState>((set, get) => ({
  likes: new Set(),
  retweets: new Set(),
  pendingLikes: new Set(),
  pendingRetweets: new Set(),

  toggleLike: async (tweetId: string) => {
    const { likes, pendingLikes } = get();

    // Prevent double-clicks
    if (pendingLikes.has(tweetId)) return;

    const isCurrentlyLiked = likes.has(tweetId);

    // Optimistic update
    set((state) => {
      const newLikes = new Set(state.likes);
      const newPending = new Set(state.pendingLikes);

      if (isCurrentlyLiked) {
        newLikes.delete(tweetId);
      } else {
        newLikes.add(tweetId);
      }
      newPending.add(tweetId);

      return { likes: newLikes, pendingLikes: newPending };
    });

    try {
      if (isCurrentlyLiked) {
        await api.unlikeTweet(tweetId);
      } else {
        await api.likeTweet(tweetId);
      }
    } catch (error) {
      // Rollback on failure
      set((state) => {
        const newLikes = new Set(state.likes);
        if (isCurrentlyLiked) {
          newLikes.add(tweetId);
        } else {
          newLikes.delete(tweetId);
        }
        return { likes: newLikes };
      });

      console.error('Failed to toggle like:', error);
    } finally {
      // Clear pending state
      set((state) => {
        const newPending = new Set(state.pendingLikes);
        newPending.delete(tweetId);
        return { pendingLikes: newPending };
      });
    }
  },

  toggleRetweet: async (tweetId: string) => {
    // Similar implementation to toggleLike
  },

  initFromServer: (likedIds: string[], retweetedIds: string[]) => {
    set({
      likes: new Set(likedIds),
      retweets: new Set(retweetedIds),
    });
  },
}));
```

### Action Button with Animation

```typescript
// components/ActionButton.tsx
import { useState } from 'react';

interface ActionButtonProps {
  icon: React.ReactNode;
  count?: number;
  active?: boolean;
  activeColor?: string;
  onClick?: () => void;
  label: string;
}

export function ActionButton({
  icon,
  count,
  active,
  activeColor,
  onClick,
  label,
}: ActionButtonProps) {
  const [isAnimating, setIsAnimating] = useState(false);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();

    if (onClick) {
      setIsAnimating(true);
      onClick();
      setTimeout(() => setIsAnimating(false), 300);
    }
  };

  return (
    <button
      onClick={handleClick}
      className={`action-button ${active ? activeColor : 'text-twitter-gray'}`}
      aria-label={label}
      aria-pressed={active}
    >
      <span className={`icon-wrapper ${isAnimating ? 'animate-pop' : ''}`}>
        {icon}
      </span>
      {count !== undefined && count > 0 && (
        <span className="count">{formatCount(count)}</span>
      )}
    </button>
  );
}

function formatCount(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return count.toString();
}
```

### CSS for Engagement Animations

```css
/* Like heart animation */
@keyframes pop {
  0% { transform: scale(1); }
  50% { transform: scale(1.3); }
  100% { transform: scale(1); }
}

.animate-pop {
  animation: pop 0.3s ease-out;
}

/* Heart fill animation */
@keyframes heart-fill {
  0% { transform: scale(0); opacity: 0; }
  50% { transform: scale(1.2); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}

.heart-icon.filled {
  animation: heart-fill 0.3s ease-out;
  fill: #F91880;
}

/* Retweet color transition */
.action-button {
  transition: color 0.15s ease-out;
}

.text-twitter-like {
  color: #F91880;
}

.text-twitter-retweet {
  color: #00BA7C;
}
```

---

## 5. Compose Tweet Component (5 minutes)

### Character Counter and Validation

```typescript
// components/ComposeTweet.tsx
import { useState, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';

const MAX_LENGTH = 280;

export function ComposeTweet({ onSuccess }: { onSuccess?: () => void }) {
  const [content, setContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const queryClient = useQueryClient();

  const remaining = MAX_LENGTH - content.length;
  const isOverLimit = remaining < 0;
  const isNearLimit = remaining <= 20 && remaining >= 0;

  const createTweetMutation = useMutation({
    mutationFn: (content: string) => api.createTweet(content),
    onSuccess: () => {
      setContent('');
      queryClient.invalidateQueries({ queryKey: ['timeline', 'home'] });
      onSuccess?.();
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (content.trim() && !isOverLimit) {
      createTweetMutation.mutate(content);
    }
  };

  // Auto-resize textarea
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);

    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  };

  return (
    <form onSubmit={handleSubmit} className="compose-tweet">
      <div className="compose-avatar">
        <CurrentUserAvatar />
      </div>

      <div className="compose-content">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          placeholder="What's happening?"
          className="compose-textarea"
          rows={1}
          aria-label="Tweet text"
        />

        <div className="compose-footer">
          <div className="compose-actions">
            <button type="button" className="media-button" aria-label="Add photo">
              <ImageIcon />
            </button>
            <button type="button" className="media-button" aria-label="Add GIF">
              <GifIcon />
            </button>
            <button type="button" className="media-button" aria-label="Add emoji">
              <EmojiIcon />
            </button>
          </div>

          <div className="compose-submit">
            <CharacterCounter remaining={remaining} />

            <button
              type="submit"
              disabled={!content.trim() || isOverLimit || createTweetMutation.isPending}
              className="tweet-button"
            >
              {createTweetMutation.isPending ? 'Posting...' : 'Tweet'}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}

function CharacterCounter({ remaining }: { remaining: number }) {
  const isOverLimit = remaining < 0;
  const isNearLimit = remaining <= 20 && remaining >= 0;

  if (remaining > 20) return null;

  return (
    <div className={`character-counter ${isOverLimit ? 'over' : isNearLimit ? 'near' : ''}`}>
      {isOverLimit ? (
        <span className="text-red-500">{remaining}</span>
      ) : (
        <svg viewBox="0 0 20 20" className="counter-circle">
          <circle
            cx="10"
            cy="10"
            r="9"
            fill="none"
            stroke={isNearLimit ? '#FFD400' : '#1DA1F2'}
            strokeWidth="2"
            strokeDasharray={`${(remaining / 20) * 56.5} 56.5`}
            transform="rotate(-90 10 10)"
          />
        </svg>
      )}
    </div>
  );
}
```

---

## 6. Trending Sidebar (5 minutes)

### Trending Topics Component

```typescript
// components/TrendingSidebar.tsx
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '@/services/api';

export function TrendingSidebar() {
  const { data: trends, isLoading } = useQuery({
    queryKey: ['trends'],
    queryFn: () => api.getTrends(),
    refetchInterval: 60000, // Refresh every minute
    staleTime: 30000,
  });

  if (isLoading) {
    return <TrendingSkeleton />;
  }

  return (
    <aside className="trending-sidebar">
      <h2 className="sidebar-title">Trends for you</h2>

      <div className="trends-list">
        {trends?.map((trend, index) => (
          <Link
            key={trend.hashtag}
            to="/hashtag/$tag"
            params={{ tag: trend.hashtag }}
            className="trend-item"
          >
            <div className="trend-meta">
              <span className="trend-category">Trending</span>
              <span className="trend-rank">#{index + 1}</span>
            </div>
            <div className="trend-hashtag">#{trend.hashtag}</div>
            <div className="trend-count">
              {formatTweetCount(trend.tweetCount)} Tweets
            </div>
          </Link>
        ))}
      </div>

      <Link to="/explore/trending" className="show-more">
        Show more
      </Link>
    </aside>
  );
}

function formatTweetCount(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return count.toString();
}
```

### CSS for Twitter Brand Styling

```css
/* Twitter brand colors */
:root {
  --twitter-blue: #1DA1F2;
  --twitter-dark-blue: #1A91DA;
  --twitter-black: #0F1419;
  --twitter-gray: #536471;
  --twitter-light-gray: #EFF3F4;
  --twitter-extra-light-gray: #F7F9FA;
  --twitter-like: #F91880;
  --twitter-retweet: #00BA7C;
}

/* Tweet card */
.tweet {
  display: flex;
  padding: 12px 16px;
  border-bottom: 1px solid var(--twitter-light-gray);
  transition: background-color 0.15s;
}

.tweet:hover {
  background-color: var(--twitter-extra-light-gray);
}

.tweet-avatar img {
  width: 48px;
  height: 48px;
  border-radius: 50%;
}

.tweet-content {
  flex: 1;
  margin-left: 12px;
}

.display-name {
  font-weight: 700;
  color: var(--twitter-black);
}

.username,
.timestamp,
.separator {
  color: var(--twitter-gray);
  font-size: 15px;
}

.tweet-text {
  color: var(--twitter-black);
  font-size: 15px;
  line-height: 1.4;
  margin-top: 4px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Tweet button */
.tweet-button {
  background-color: var(--twitter-blue);
  color: white;
  font-weight: 700;
  padding: 12px 24px;
  border-radius: 9999px;
  transition: background-color 0.15s;
}

.tweet-button:hover:not(:disabled) {
  background-color: var(--twitter-dark-blue);
}

.tweet-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Trending sidebar */
.trending-sidebar {
  background-color: var(--twitter-extra-light-gray);
  border-radius: 16px;
  overflow: hidden;
}

.sidebar-title {
  font-size: 20px;
  font-weight: 800;
  padding: 12px 16px;
  color: var(--twitter-black);
}

.trend-item {
  display: block;
  padding: 12px 16px;
  transition: background-color 0.15s;
}

.trend-item:hover {
  background-color: rgba(0, 0, 0, 0.03);
}

.trend-hashtag {
  font-weight: 700;
  color: var(--twitter-black);
}

.trend-count {
  font-size: 13px;
  color: var(--twitter-gray);
}
```

---

## 7. Responsive Layout (5 minutes)

### Three-Column Desktop, Single Column Mobile

```typescript
// components/Layout.tsx
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="layout">
      <LeftSidebar />
      <main className="main-content">
        {children}
      </main>
      <RightSidebar />
    </div>
  );
}
```

### Responsive CSS

```css
/* Mobile-first layout */
.layout {
  min-height: 100vh;
  max-width: 1280px;
  margin: 0 auto;
}

.main-content {
  min-height: 100vh;
  border-left: 1px solid var(--twitter-light-gray);
  border-right: 1px solid var(--twitter-light-gray);
}

/* Hide sidebars on mobile */
.left-sidebar,
.right-sidebar {
  display: none;
}

/* Tablet: Show left sidebar */
@media (min-width: 640px) {
  .layout {
    display: grid;
    grid-template-columns: 88px 1fr;
  }

  .left-sidebar {
    display: flex;
    flex-direction: column;
    position: sticky;
    top: 0;
    height: 100vh;
  }
}

/* Desktop: Full three-column */
@media (min-width: 1024px) {
  .layout {
    grid-template-columns: 275px 600px 350px;
  }

  .left-sidebar {
    padding: 0 12px;
  }

  .right-sidebar {
    display: block;
    padding: 0 16px;
  }
}

/* Large desktop: More sidebar space */
@media (min-width: 1280px) {
  .layout {
    grid-template-columns: 275px 600px 1fr;
  }

  .right-sidebar {
    max-width: 350px;
  }
}
```

---

## 8. Accessibility Features (4 minutes)

### ARIA Labels and Roles

```typescript
// Accessible tweet component
function Tweet({ tweet }: TweetProps) {
  return (
    <article
      className="tweet"
      aria-label={`Tweet by ${tweet.author.displayName}`}
    >
      <div className="tweet-avatar" aria-hidden="true">
        <img src={tweet.author.avatarUrl} alt="" />
      </div>

      <div className="tweet-content">
        <header className="tweet-header">
          <span className="display-name">{tweet.author.displayName}</span>
          <span className="username" aria-label={`username ${tweet.author.username}`}>
            @{tweet.author.username}
          </span>
          <time
            dateTime={tweet.createdAt}
            title={new Date(tweet.createdAt).toLocaleString()}
          >
            {formatDistanceToNow(new Date(tweet.createdAt))}
          </time>
        </header>

        <p className="tweet-text">{parseContent(tweet.content)}</p>

        <footer className="tweet-actions" role="group" aria-label="Tweet actions">
          <ActionButton
            icon={<ReplyIcon />}
            count={tweet.replyCount}
            label={`Reply, ${tweet.replyCount} replies`}
          />
          {/* ... other actions */}
        </footer>
      </div>
    </article>
  );
}
```

### Keyboard Navigation

```typescript
// Timeline keyboard navigation
function Timeline({ tweets }: TimelineProps) {
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const tweetRefs = useRef<(HTMLElement | null)[]>([]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        e.preventDefault();
        setFocusedIndex((prev) => Math.min(prev + 1, tweets.length - 1));
        break;
      case 'ArrowUp':
      case 'k':
        e.preventDefault();
        setFocusedIndex((prev) => Math.max(prev - 1, 0));
        break;
      case 'l':
        // Like focused tweet
        if (focusedIndex >= 0) {
          toggleLike(tweets[focusedIndex].id);
        }
        break;
      case 'r':
        // Reply to focused tweet
        if (focusedIndex >= 0) {
          openReplyModal(tweets[focusedIndex].id);
        }
        break;
    }
  };

  useEffect(() => {
    if (focusedIndex >= 0 && tweetRefs.current[focusedIndex]) {
      tweetRefs.current[focusedIndex]?.focus();
    }
  }, [focusedIndex]);

  return (
    <div
      role="feed"
      aria-label="Timeline"
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      {tweets.map((tweet, index) => (
        <Tweet
          key={tweet.id}
          tweet={tweet}
          ref={(el) => (tweetRefs.current[index] = el)}
          tabIndex={index === focusedIndex ? 0 : -1}
        />
      ))}
    </div>
  );
}
```

---

## 9. Summary (3 minutes)

### Key Frontend Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Virtualization | @tanstack/react-virtual | Handle thousands of tweets efficiently |
| State | Zustand + React Query | Simple state + server cache separation |
| Optimistic Updates | Local Set tracking | Instant feedback, rollback on failure |
| Styling | Tailwind + CSS Variables | Rapid development with brand consistency |
| Routing | TanStack Router | File-based, type-safe routing |

### Performance Metrics

| Metric | Target | Implementation |
|--------|--------|----------------|
| Initial Load | < 1.5s | Code splitting, lazy routes |
| Timeline Render | < 100ms | Virtualization, memoization |
| Engagement Action | < 50ms | Optimistic updates |
| Scroll Performance | 60fps | Only ~80 DOM nodes |

### Trade-offs Made

1. **Virtualization complexity** vs. simple list - chose virtualization for scale
2. **Optimistic updates** vs. wait for server - chose optimism for better UX
3. **Character counter** as SVG circle vs. text - chose visual for Twitter feel
4. **Memoized tweets** - chose memoization to prevent unnecessary re-renders

### What Would Be Different at Scale

1. **Server-side rendering**: Initial timeline rendered on server
2. **Service workers**: Offline timeline access, background sync
3. **Media CDN**: Image optimization, lazy loading with blur placeholders
4. **WebSocket**: Real-time timeline updates, live engagement counts
5. **Internationalization**: RTL support, localized timestamps
