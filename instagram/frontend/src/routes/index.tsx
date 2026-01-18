/**
 * Home page component - Instagram feed with stories and posts.
 * Uses TanStack Virtual for efficient rendering of the post feed,
 * only rendering items visible in the viewport.
 *
 * Features:
 * - Story tray at top with user stories
 * - Virtualized feed for performance with large post counts
 * - Dynamic height measurement for variable post sizes (images, captions)
 * - Infinite scroll with automatic load-more triggering
 * - Loading skeleton states
 *
 * @module routes/index
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAuthStore } from '../stores/authStore';
import { feedApi, storiesApi } from '../services/api';
import type { Post, StoryUser } from '../types';
import { PostCard } from '../components/PostCard';
import { StoryTray } from '../components/StoryTray';

export const Route = createFileRoute('/')({
  component: HomePage,
});

/**
 * Main home page component displaying the Instagram feed.
 * Shows stories tray and virtualized post feed with infinite scroll.
 *
 * @returns Home page with stories and feed
 */
function HomePage() {
  const { isAuthenticated, isLoading } = useAuthStore();
  const [posts, setPosts] = useState<Post[]>([]);
  const [storyUsers, setStoryUsers] = useState<StoryUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isAuthenticated) {
      loadFeed();
      loadStoryTray();
    }
  }, [isAuthenticated]);

  const loadFeed = async (cursor?: string) => {
    try {
      setLoading(true);
      const response = await feedApi.getFeed(cursor);
      if (cursor) {
        setPosts((prev) => [...prev, ...response.posts]);
      } else {
        setPosts(response.posts);
      }
      setNextCursor(response.nextCursor);
    } catch (error) {
      console.error('Error loading feed:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadStoryTray = async () => {
    try {
      const response = await storiesApi.getTray();
      setStoryUsers(response.users);
    } catch (error) {
      console.error('Error loading story tray:', error);
    }
  };

  const handleStoryViewed = (userId: string) => {
    setStoryUsers((prev) =>
      prev.map((user) =>
        user.id === userId ? { ...user, hasSeen: true } : user
      )
    );
  };

  // Virtual list for feed posts with dynamic height measurement
  const virtualizer = useVirtualizer({
    count: posts.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 600, // Estimate: header(60) + image(400) + actions(60) + caption(80)
    overscan: 3, // Render 3 extra items above/below for smoother scrolling
    measureElement: (element) => {
      // Measure actual element height for accurate positioning
      return element.getBoundingClientRect().height;
    },
  });

  // Infinite scroll: load more when near bottom
  const handleScroll = useCallback(() => {
    if (!parentRef.current || loading || !nextCursor) return;

    const { scrollTop, scrollHeight, clientHeight } = parentRef.current;
    if (scrollHeight - scrollTop - clientHeight < 500) {
      loadFeed(nextCursor);
    }
  }, [loading, nextCursor]);

  useEffect(() => {
    const parent = parentRef.current;
    if (parent) {
      parent.addEventListener('scroll', handleScroll);
      return () => parent.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      className="max-w-lg mx-auto h-[calc(100vh-60px)] overflow-auto"
    >
      {/* Story Tray - Fixed at top, not virtualized */}
      {storyUsers.length > 0 && (
        <StoryTray users={storyUsers} onStoryViewed={handleStoryViewed} />
      )}

      {/* Feed - Virtualized */}
      {loading && posts.length === 0 ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-white border border-border-gray rounded-lg">
              <div className="flex items-center gap-3 p-4">
                <div className="w-10 h-10 rounded-full skeleton" />
                <div className="flex-1">
                  <div className="h-4 w-24 skeleton rounded" />
                </div>
              </div>
              <div className="aspect-square skeleton" />
              <div className="p-4 space-y-2">
                <div className="h-4 w-20 skeleton rounded" />
                <div className="h-4 w-full skeleton rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : posts.length === 0 ? (
        <div className="text-center py-12 bg-white border border-border-gray rounded-lg">
          <svg
            className="w-16 h-16 mx-auto mb-4 text-text-secondary"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1}
              d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
            />
          </svg>
          <h2 className="text-xl font-light mb-2">Welcome to Instagram</h2>
          <p className="text-text-secondary">
            Follow people to see their photos and videos here.
          </p>
        </div>
      ) : (
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualItems.map((virtualItem) => {
            const post = posts[virtualItem.index];
            if (!post) return null;

            return (
              <div
                key={post.id}
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
                <PostCard post={post} />
              </div>
            );
          })}
        </div>
      )}

      {/* Loading indicator at bottom */}
      {loading && posts.length > 0 && (
        <div className="py-4 text-center">
          <div className="animate-spin inline-block rounded-full h-6 w-6 border-t-2 border-primary" />
        </div>
      )}
    </div>
  );
}
