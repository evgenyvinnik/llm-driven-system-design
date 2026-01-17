import { useState, useEffect } from 'react';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { feedApi, storiesApi } from '../services/api';
import type { Post, StoryUser } from '../types';
import { PostCard } from '../components/PostCard';
import { StoryTray } from '../components/StoryTray';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const { isAuthenticated, isLoading } = useAuthStore();
  const [posts, setPosts] = useState<Post[]>([]);
  const [storyUsers, setStoryUsers] = useState<StoryUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

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

  return (
    <div className="max-w-lg mx-auto">
      {/* Story Tray */}
      {storyUsers.length > 0 && (
        <StoryTray users={storyUsers} onStoryViewed={handleStoryViewed} />
      )}

      {/* Feed */}
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
            className="w-16 h-16 mx-auto mb-4 text-text-gray"
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
          <p className="text-text-gray">
            Follow people to see their photos and videos here.
          </p>
        </div>
      ) : (
        <>
          {posts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
          {nextCursor && (
            <button
              onClick={() => loadFeed(nextCursor)}
              disabled={loading}
              className="w-full py-3 text-primary font-semibold disabled:opacity-50"
            >
              {loading ? 'Loading...' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
