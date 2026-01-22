# YouTube Top K Videos - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement (1 minute)

"I'll design the frontend for a real-time trending videos dashboard that displays Top K videos across categories with live updates. The core frontend challenges are: building a responsive trending grid that handles real-time SSE updates without jarring reflows, implementing smooth category filtering with animated transitions, and designing an engaging video card component with view count animations. I'll focus on the component architecture, state management with Zustand, and performance optimizations for handling frequent data updates."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Trending Display**: Show Top 10 videos per category in an engaging grid
- **Category Filtering**: Quick switching between categories (all, music, gaming, etc.)
- **Real-time Updates**: Live view count updates via SSE connection
- **Video Details**: Thumbnails, titles, view counts, rank indicators
- **View Simulation**: Button to simulate views for testing

### Non-Functional Requirements
- **Responsiveness**: Works on mobile, tablet, and desktop
- **Performance**: Smooth 60fps animations during updates
- **Accessibility**: Keyboard navigation, screen reader support
- **Offline**: Graceful degradation when SSE disconnects

### UI/UX Considerations
- **Visual feedback**: Rank changes should be animated
- **View count animation**: Numbers should count up smoothly
- **Loading states**: Skeleton screens while data loads
- **Error handling**: Clear messages when connection fails

### Key Frontend Questions
1. How frequently do rankings change? (affects animation strategy)
2. Should we show rank change indicators (+2, -1)?
3. What interaction triggers a video view?

## Component Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                         App Shell                                │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                       Header                                │ │
│  │  Logo    |    Category Tabs    |    Connection Status      │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                   TrendingDashboard                         │ │
│  │  ┌─────────────────────────────────────────────────────┐   │ │
│  │  │              CategoryTabs                            │   │ │
│  │  │  [ All ] [ Music ] [ Gaming ] [ Sports ] [ News ]   │   │ │
│  │  └─────────────────────────────────────────────────────┘   │ │
│  │                                                             │ │
│  │  ┌─────────────────────────────────────────────────────┐   │ │
│  │  │              TrendingGrid                            │   │ │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐            │   │ │
│  │  │  │VideoCard │ │VideoCard │ │VideoCard │            │   │ │
│  │  │  │  #1      │ │  #2      │ │  #3      │            │   │ │
│  │  │  └──────────┘ └──────────┘ └──────────┘            │   │ │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐            │   │ │
│  │  │  │VideoCard │ │VideoCard │ │VideoCard │            │   │ │
│  │  │  │  #4      │ │  #5      │ │  #6      │            │   │ │
│  │  │  └──────────┘ └──────────┘ └──────────┘            │   │ │
│  │  └─────────────────────────────────────────────────────┘   │ │
│  │                                                             │ │
│  │  ┌─────────────────────────────────────────────────────┐   │ │
│  │  │              ViewSimulator                           │   │ │
│  │  │  Select Video  [ ▼ ]  [ Simulate View ] [ Bulk x100]│   │ │
│  │  └─────────────────────────────────────────────────────┘   │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                       Stats Bar                             │ │
│  │  Connected: ✓  |  Last Update: 2s ago  |  Total Views: 10K │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Component Tree

```
src/
├── routes/
│   ├── __root.tsx           # App shell with SSE provider
│   ├── index.tsx            # Trending dashboard page
│   └── video.$id.tsx        # Individual video page
├── components/
│   ├── trending/
│   │   ├── TrendingDashboard.tsx
│   │   ├── TrendingGrid.tsx
│   │   ├── VideoCard.tsx
│   │   └── CategoryTabs.tsx
│   ├── common/
│   │   ├── AnimatedNumber.tsx
│   │   ├── RankBadge.tsx
│   │   ├── ConnectionStatus.tsx
│   │   └── SkeletonCard.tsx
│   └── simulator/
│       └── ViewSimulator.tsx
├── hooks/
│   ├── useSSE.ts
│   ├── useTrending.ts
│   └── useAnimatedValue.ts
├── stores/
│   └── trendingStore.ts
└── services/
    └── api.ts
```

## Deep Dive: SSE Connection Hook (8 minutes)

### Robust SSE Hook with Reconnection

```tsx
// hooks/useSSE.ts
import { useEffect, useRef, useCallback } from 'react';
import { useTrendingStore } from '../stores/trendingStore';

interface UseSSEOptions {
  url: string;
  onMessage?: (data: unknown) => void;
  onError?: (error: Event) => void;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

interface UseSSEReturn {
  isConnected: boolean;
  reconnectAttempts: number;
  lastEventTime: Date | null;
  reconnect: () => void;
}

export function useSSE({
  url,
  onMessage,
  onError,
  reconnectInterval = 3000,
  maxReconnectAttempts = 10
}: UseSSEOptions): UseSSEReturn {
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);

  const {
    setConnected,
    setTrending,
    isConnected,
    lastEventTime,
    setLastEventTime
  } = useTrendingStore();

  const connect = useCallback(() => {
    // Clean up existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      console.log('SSE connected');
      setConnected(true);
      reconnectAttemptsRef.current = 0;
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setLastEventTime(new Date());
        setTrending(data);
        onMessage?.(data);
      } catch (err) {
        console.error('Failed to parse SSE message:', err);
      }
    };

    eventSource.onerror = (error) => {
      console.error('SSE error:', error);
      setConnected(false);
      eventSource.close();
      onError?.(error);

      // Attempt reconnection with exponential backoff
      if (reconnectAttemptsRef.current < maxReconnectAttempts) {
        const delay = reconnectInterval * Math.pow(2, reconnectAttemptsRef.current);
        reconnectAttemptsRef.current++;

        console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`);

        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, Math.min(delay, 30000)); // Cap at 30 seconds
      }
    };
  }, [url, onMessage, onError, reconnectInterval, maxReconnectAttempts, setConnected, setTrending, setLastEventTime]);

  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect]);

  useEffect(() => {
    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [connect]);

  return {
    isConnected,
    reconnectAttempts: reconnectAttemptsRef.current,
    lastEventTime,
    reconnect
  };
}
```

### Connection Status Component

```tsx
// components/common/ConnectionStatus.tsx
import { useSSE } from '../../hooks/useSSE';
import { formatDistanceToNow } from 'date-fns';

export function ConnectionStatus() {
  const { isConnected, lastEventTime, reconnect, reconnectAttempts } =
    useSSE({ url: '/api/sse/trending' });

  return (
    <div className="flex items-center gap-2 text-sm">
      {/* Connection indicator */}
      <div className="flex items-center gap-1.5">
        <span
          className={`w-2 h-2 rounded-full ${
            isConnected
              ? 'bg-green-500 animate-pulse'
              : 'bg-red-500'
          }`}
          aria-hidden="true"
        />
        <span className={isConnected ? 'text-green-600' : 'text-red-600'}>
          {isConnected ? 'Live' : 'Disconnected'}
        </span>
      </div>

      {/* Last update time */}
      {lastEventTime && (
        <span className="text-gray-500">
          Updated {formatDistanceToNow(lastEventTime, { addSuffix: true })}
        </span>
      )}

      {/* Reconnect button when disconnected */}
      {!isConnected && (
        <button
          onClick={reconnect}
          className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
        >
          Reconnect {reconnectAttempts > 0 && `(${reconnectAttempts})`}
        </button>
      )}
    </div>
  );
}
```

## Deep Dive: Zustand Store with Optimistic Updates (7 minutes)

### Trending Store

```tsx
// stores/trendingStore.ts
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

interface Video {
  videoId: string;
  title: string;
  viewCount: number;
  rank: number;
  previousRank?: number;
  thumbnail?: string;
  category?: string;
}

interface CategoryTrending {
  videos: Video[];
  computedAt: Date;
}

interface TrendingState {
  // Connection state
  isConnected: boolean;
  lastEventTime: Date | null;

  // Trending data by category
  trending: Record<string, CategoryTrending>;

  // Previous state for animations
  previousTrending: Record<string, CategoryTrending>;

  // UI state
  selectedCategory: string;
  isLoading: boolean;

  // Actions
  setConnected: (connected: boolean) => void;
  setLastEventTime: (time: Date) => void;
  setTrending: (data: Record<string, CategoryTrending>) => void;
  setSelectedCategory: (category: string) => void;
  getVideosForCategory: (category: string) => Video[];
}

export const useTrendingStore = create<TrendingState>()(
  subscribeWithSelector((set, get) => ({
    isConnected: false,
    lastEventTime: null,
    trending: {},
    previousTrending: {},
    selectedCategory: 'all',
    isLoading: true,

    setConnected: (connected) => set({ isConnected: connected }),

    setLastEventTime: (time) => set({ lastEventTime: time }),

    setTrending: (data) => {
      const current = get().trending;

      // Calculate rank changes
      const enrichedData: Record<string, CategoryTrending> = {};

      for (const [category, categoryData] of Object.entries(data)) {
        const previousCategory = current[category];

        const videosWithRankChange = categoryData.videos.map((video) => {
          const previousVideo = previousCategory?.videos.find(
            (v) => v.videoId === video.videoId
          );

          return {
            ...video,
            previousRank: previousVideo?.rank
          };
        });

        enrichedData[category] = {
          ...categoryData,
          videos: videosWithRankChange,
          computedAt: new Date(categoryData.computedAt)
        };
      }

      set({
        previousTrending: current,
        trending: enrichedData,
        isLoading: false
      });
    },

    setSelectedCategory: (category) => set({ selectedCategory: category }),

    getVideosForCategory: (category) => {
      const { trending } = get();
      return trending[category]?.videos || [];
    }
  }))
);

// Selector for current category videos
export const useCurrentCategoryVideos = () =>
  useTrendingStore((state) =>
    state.trending[state.selectedCategory]?.videos || []
  );

// Selector for rank change detection
export const useVideoRankChange = (videoId: string) =>
  useTrendingStore((state) => {
    const category = state.selectedCategory;
    const currentVideo = state.trending[category]?.videos.find(
      (v) => v.videoId === videoId
    );
    const previousVideo = state.previousTrending[category]?.videos.find(
      (v) => v.videoId === videoId
    );

    if (!currentVideo) return null;

    const rankChange = previousVideo
      ? previousVideo.rank - currentVideo.rank
      : 0;

    return {
      current: currentVideo.rank,
      previous: previousVideo?.rank,
      change: rankChange,
      isNew: !previousVideo
    };
  });
```

## Deep Dive: Animated Video Card (8 minutes)

### AnimatedNumber Component

```tsx
// components/common/AnimatedNumber.tsx
import { useEffect, useState, useRef } from 'react';

interface AnimatedNumberProps {
  value: number;
  duration?: number;
  formatFn?: (value: number) => string;
  className?: string;
}

export function AnimatedNumber({
  value,
  duration = 500,
  formatFn = (v) => v.toLocaleString(),
  className
}: AnimatedNumberProps) {
  const [displayValue, setDisplayValue] = useState(value);
  const previousValue = useRef(value);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    const startValue = previousValue.current;
    const endValue = value;
    const startTime = performance.now();

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);

      const current = Math.round(startValue + (endValue - startValue) * eased);
      setDisplayValue(current);

      if (progress < 1) {
        animationRef.current = requestAnimationFrame(animate);
      } else {
        previousValue.current = endValue;
      }
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [value, duration]);

  return (
    <span className={className} aria-live="polite">
      {formatFn(displayValue)}
    </span>
  );
}
```

### RankBadge with Change Indicator

```tsx
// components/common/RankBadge.tsx
import { useVideoRankChange } from '../../stores/trendingStore';
import { useEffect, useState } from 'react';

interface RankBadgeProps {
  videoId: string;
  rank: number;
}

export function RankBadge({ videoId, rank }: RankBadgeProps) {
  const rankChange = useVideoRankChange(videoId);
  const [showChange, setShowChange] = useState(false);

  useEffect(() => {
    if (rankChange && rankChange.change !== 0) {
      setShowChange(true);
      const timer = setTimeout(() => setShowChange(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [rankChange]);

  const getBadgeColor = () => {
    if (rank === 1) return 'bg-yellow-500 text-white';
    if (rank === 2) return 'bg-gray-400 text-white';
    if (rank === 3) return 'bg-amber-600 text-white';
    return 'bg-gray-200 text-gray-700';
  };

  return (
    <div className="relative">
      {/* Rank number */}
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center font-bold ${getBadgeColor()}`}
      >
        {rank}
      </div>

      {/* Rank change indicator */}
      {showChange && rankChange && rankChange.change !== 0 && (
        <div
          className={`absolute -top-2 -right-2 px-1 py-0.5 text-xs font-medium rounded ${
            rankChange.change > 0
              ? 'bg-green-500 text-white'
              : 'bg-red-500 text-white'
          } animate-bounce`}
        >
          {rankChange.change > 0 ? `+${rankChange.change}` : rankChange.change}
        </div>
      )}

      {/* New entry indicator */}
      {rankChange?.isNew && (
        <div className="absolute -top-2 -right-2 px-1 py-0.5 text-xs font-medium rounded bg-blue-500 text-white">
          NEW
        </div>
      )}
    </div>
  );
}
```

### VideoCard Component

```tsx
// components/trending/VideoCard.tsx
import { memo, useState } from 'react';
import { AnimatedNumber } from '../common/AnimatedNumber';
import { RankBadge } from '../common/RankBadge';
import { api } from '../../services/api';

interface VideoCardProps {
  videoId: string;
  title: string;
  viewCount: number;
  rank: number;
  thumbnail?: string;
  channelName?: string;
  duration?: number;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatViews(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toString();
}

export const VideoCard = memo(function VideoCard({
  videoId,
  title,
  viewCount,
  rank,
  thumbnail,
  channelName = 'Unknown Channel',
  duration = 180
}: VideoCardProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);

  const handleSimulateView = async () => {
    setIsSimulating(true);
    try {
      await api.recordView(videoId);
    } catch (err) {
      console.error('Failed to record view:', err);
    } finally {
      setIsSimulating(false);
    }
  };

  return (
    <article
      className={`group relative bg-white rounded-xl shadow-sm overflow-hidden transition-all duration-300 ${
        isHovered ? 'shadow-lg scale-[1.02]' : ''
      }`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Thumbnail */}
      <div className="relative aspect-video bg-gray-200">
        {thumbnail ? (
          <img
            src={thumbnail}
            alt={`Thumbnail for ${title}`}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-gray-200 to-gray-300">
            <span className="text-4xl">🎬</span>
          </div>
        )}

        {/* Duration badge */}
        <div className="absolute bottom-2 right-2 px-1.5 py-0.5 bg-black/80 text-white text-xs rounded">
          {formatDuration(duration)}
        </div>

        {/* Rank badge */}
        <div className="absolute top-2 left-2">
          <RankBadge videoId={videoId} rank={rank} />
        </div>

        {/* Play button on hover */}
        <button
          onClick={handleSimulateView}
          disabled={isSimulating}
          className={`absolute inset-0 flex items-center justify-center bg-black/40 transition-opacity ${
            isHovered ? 'opacity-100' : 'opacity-0'
          }`}
          aria-label={`Play ${title}`}
        >
          <div className="w-16 h-16 rounded-full bg-white/90 flex items-center justify-center">
            {isSimulating ? (
              <span className="animate-spin">⏳</span>
            ) : (
              <span className="text-3xl ml-1">▶</span>
            )}
          </div>
        </button>
      </div>

      {/* Video info */}
      <div className="p-4">
        <h3 className="font-medium text-gray-900 line-clamp-2 min-h-[2.5rem]">
          {title}
        </h3>

        <p className="text-sm text-gray-500 mt-1">{channelName}</p>

        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-1 text-sm text-gray-600">
            <span className="text-red-500">👁</span>
            <AnimatedNumber
              value={viewCount}
              formatFn={formatViews}
              className="font-medium"
            />
            <span>views</span>
          </div>

          {/* Trending indicator */}
          <div className="flex items-center gap-1 text-orange-500">
            <span>🔥</span>
            <span className="text-xs font-medium">Trending</span>
          </div>
        </div>
      </div>
    </article>
  );
});
```

## Deep Dive: Category Tabs with Animated Underline (5 minutes)

### CategoryTabs Component

```tsx
// components/trending/CategoryTabs.tsx
import { useTrendingStore } from '../../stores/trendingStore';
import { useRef, useState, useLayoutEffect } from 'react';

const CATEGORIES = [
  { id: 'all', label: 'All', emoji: '🌟' },
  { id: 'music', label: 'Music', emoji: '🎵' },
  { id: 'gaming', label: 'Gaming', emoji: '🎮' },
  { id: 'sports', label: 'Sports', emoji: '⚽' },
  { id: 'news', label: 'News', emoji: '📰' },
  { id: 'education', label: 'Education', emoji: '📚' }
];

export function CategoryTabs() {
  const { selectedCategory, setSelectedCategory } = useTrendingStore();
  const tabsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [underlineStyle, setUnderlineStyle] = useState({ left: 0, width: 0 });

  // Update underline position when selection changes
  useLayoutEffect(() => {
    const selectedTab = tabsRef.current.get(selectedCategory);
    if (selectedTab) {
      const { offsetLeft, offsetWidth } = selectedTab;
      setUnderlineStyle({ left: offsetLeft, width: offsetWidth });
    }
  }, [selectedCategory]);

  return (
    <nav
      className="relative border-b border-gray-200"
      role="tablist"
      aria-label="Video categories"
    >
      <div className="flex gap-1 overflow-x-auto scrollbar-hide">
        {CATEGORIES.map((category) => (
          <button
            key={category.id}
            ref={(el) => {
              if (el) tabsRef.current.set(category.id, el);
            }}
            role="tab"
            aria-selected={selectedCategory === category.id}
            aria-controls={`panel-${category.id}`}
            onClick={() => setSelectedCategory(category.id)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
              selectedCategory === category.id
                ? 'text-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <span aria-hidden="true">{category.emoji}</span>
            <span>{category.label}</span>
          </button>
        ))}
      </div>

      {/* Animated underline */}
      <div
        className="absolute bottom-0 h-0.5 bg-blue-600 transition-all duration-300 ease-out"
        style={{
          left: underlineStyle.left,
          width: underlineStyle.width
        }}
      />
    </nav>
  );
}
```

### TrendingGrid with Layout Animations

```tsx
// components/trending/TrendingGrid.tsx
import { useCurrentCategoryVideos, useTrendingStore } from '../../stores/trendingStore';
import { VideoCard } from './VideoCard';
import { SkeletonCard } from '../common/SkeletonCard';
import { useAutoAnimate } from '@formkit/auto-animate/react';

export function TrendingGrid() {
  const videos = useCurrentCategoryVideos();
  const isLoading = useTrendingStore((state) => state.isLoading);
  const [gridRef] = useAutoAnimate<HTMLDivElement>();

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 p-6">
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (videos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-500">
        <span className="text-6xl mb-4">📊</span>
        <p className="text-lg">No trending videos yet</p>
        <p className="text-sm">Start recording views to see trends</p>
      </div>
    );
  }

  return (
    <div
      ref={gridRef}
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 p-6"
      role="tabpanel"
      aria-live="polite"
    >
      {videos.map((video) => (
        <VideoCard
          key={video.videoId}
          videoId={video.videoId}
          title={video.title}
          viewCount={video.viewCount}
          rank={video.rank}
          thumbnail={video.thumbnail}
        />
      ))}
    </div>
  );
}
```

### Skeleton Loading Card

```tsx
// components/common/SkeletonCard.tsx
export function SkeletonCard() {
  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden animate-pulse">
      {/* Thumbnail skeleton */}
      <div className="aspect-video bg-gray-200" />

      {/* Content skeleton */}
      <div className="p-4 space-y-3">
        <div className="h-4 bg-gray-200 rounded w-3/4" />
        <div className="h-4 bg-gray-200 rounded w-1/2" />
        <div className="flex justify-between">
          <div className="h-3 bg-gray-200 rounded w-1/4" />
          <div className="h-3 bg-gray-200 rounded w-1/4" />
        </div>
      </div>
    </div>
  );
}
```

## Deep Dive: View Simulator Panel (4 minutes)

```tsx
// components/simulator/ViewSimulator.tsx
import { useState } from 'react';
import { useTrendingStore } from '../../stores/trendingStore';
import { api } from '../../services/api';

export function ViewSimulator() {
  const videos = useTrendingStore((state) =>
    state.trending['all']?.videos || []
  );
  const [selectedVideoId, setSelectedVideoId] = useState('');
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationCount, setSimulationCount] = useState(0);

  const handleSingleView = async () => {
    if (!selectedVideoId) return;

    setIsSimulating(true);
    try {
      await api.recordView(selectedVideoId);
      setSimulationCount((c) => c + 1);
    } catch (err) {
      console.error('Failed to record view:', err);
    } finally {
      setIsSimulating(false);
    }
  };

  const handleBulkViews = async (count: number) => {
    if (!selectedVideoId) return;

    setIsSimulating(true);
    try {
      await api.recordBulkViews(selectedVideoId, count);
      setSimulationCount((c) => c + count);
    } catch (err) {
      console.error('Failed to record bulk views:', err);
    } finally {
      setIsSimulating(false);
    }
  };

  const handleRandomViews = async () => {
    if (videos.length === 0) return;

    setIsSimulating(true);
    try {
      // Record 10 random views across different videos
      const promises = Array.from({ length: 10 }).map(() => {
        const randomVideo = videos[Math.floor(Math.random() * videos.length)];
        return api.recordView(randomVideo.videoId);
      });
      await Promise.all(promises);
      setSimulationCount((c) => c + 10);
    } catch (err) {
      console.error('Failed to record random views:', err);
    } finally {
      setIsSimulating(false);
    }
  };

  return (
    <div className="bg-gray-50 border-t border-gray-200 p-4">
      <div className="max-w-4xl mx-auto">
        <h3 className="text-sm font-medium text-gray-700 mb-3">
          View Simulator
          {simulationCount > 0 && (
            <span className="ml-2 text-gray-400">
              ({simulationCount} simulated)
            </span>
          )}
        </h3>

        <div className="flex flex-wrap items-center gap-3">
          {/* Video selector */}
          <select
            value={selectedVideoId}
            onChange={(e) => setSelectedVideoId(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">Select a video...</option>
            {videos.map((video) => (
              <option key={video.videoId} value={video.videoId}>
                #{video.rank} - {video.title.slice(0, 40)}...
              </option>
            ))}
          </select>

          {/* Single view button */}
          <button
            onClick={handleSingleView}
            disabled={!selectedVideoId || isSimulating}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {isSimulating ? 'Simulating...' : '+1 View'}
          </button>

          {/* Bulk view buttons */}
          <div className="flex gap-2">
            {[10, 100, 1000].map((count) => (
              <button
                key={count}
                onClick={() => handleBulkViews(count)}
                disabled={!selectedVideoId || isSimulating}
                className="px-3 py-2 bg-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-300 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
              >
                +{count}
              </button>
            ))}
          </div>

          {/* Random views button */}
          <button
            onClick={handleRandomViews}
            disabled={videos.length === 0 || isSimulating}
            className="px-4 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            🎲 Random x10
          </button>
        </div>
      </div>
    </div>
  );
}
```

## Trade-offs and Alternatives (3 minutes)

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| Real-time connection | SSE | Simple, unidirectional | WebSocket for bidirectional |
| State management | Zustand | Lightweight, simple API | Redux for complex flows |
| Layout animations | auto-animate | Easy to use | Framer Motion for more control |
| Number animations | requestAnimationFrame | Smooth, 60fps | CSS transitions (less control) |
| Card updates | memo + key | Prevents unnecessary re-renders | Virtual list for 100+ cards |

### Performance Optimizations

```tsx
// 1. Memoize video cards to prevent re-renders
export const VideoCard = memo(function VideoCard(props) { ... });

// 2. Use selectors to minimize store subscriptions
const videos = useTrendingStore((state) =>
  state.trending[state.selectedCategory]?.videos || []
);

// 3. Debounce rapid SSE updates if needed
const debouncedSetTrending = useMemo(
  () => debounce(setTrending, 100),
  [setTrending]
);

// 4. Use CSS containment for cards
.video-card {
  contain: layout style;
}
```

## Accessibility Features (2 minutes)

```tsx
// Keyboard navigation for category tabs
function handleKeyDown(e: KeyboardEvent) {
  const tabs = CATEGORIES.map((c) => c.id);
  const currentIndex = tabs.indexOf(selectedCategory);

  if (e.key === 'ArrowRight') {
    const nextIndex = (currentIndex + 1) % tabs.length;
    setSelectedCategory(tabs[nextIndex]);
  } else if (e.key === 'ArrowLeft') {
    const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    setSelectedCategory(tabs[prevIndex]);
  }
}

// Screen reader announcements for rank changes
<div role="status" aria-live="polite" className="sr-only">
  {`${title} is now ranked #${rank}`}
</div>

// Focus management for video cards
<article
  tabIndex={0}
  onKeyDown={(e) => e.key === 'Enter' && handlePlay()}
  aria-label={`${title}, ranked #${rank}, ${viewCount} views`}
>
```

## Closing Summary (1 minute)

"The YouTube Top K frontend is built around three key patterns:

1. **Robust SSE connection with auto-reconnect** - The useSSE hook handles connection lifecycle, exponential backoff reconnection, and updates the Zustand store when new trending data arrives.

2. **Animated updates with rank tracking** - The store tracks previous rankings to enable smooth animations. AnimatedNumber provides counting animations, RankBadge shows rank changes, and auto-animate handles grid reordering.

3. **Optimized component architecture** - VideoCards are memoized, selectors minimize re-renders, and skeleton loading provides good perceived performance.

The main trade-off is update frequency vs. visual stability. Rapid updates can cause jarring UI changes, so I'd implement debouncing or batch animations for high-frequency updates. For future improvements, I'd add keyboard shortcuts for power users, picture-in-picture video previews on hover, and offline support with service workers."
