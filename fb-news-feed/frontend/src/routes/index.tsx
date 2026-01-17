import { createFileRoute, redirect } from '@tanstack/react-router';
import { useEffect, useCallback, useRef } from 'react';
import { PostComposer } from '@/components/PostComposer';
import { PostCard } from '@/components/PostCard';
import { useFeedStore } from '@/stores/feedStore';
import { useAuthStore } from '@/stores/authStore';
import { postsApi } from '@/services/api';

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      throw redirect({ to: '/login' });
    }
  },
  component: HomePage,
});

function HomePage() {
  const { posts, isLoading, hasMore, error, fetchFeed, removePost } = useFeedStore();
  const { isAuthenticated } = useAuthStore();
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isAuthenticated) {
      fetchFeed(true);
    }
  }, [isAuthenticated, fetchFeed]);

  const handleObserver = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const [entry] = entries;
      if (entry.isIntersecting && hasMore && !isLoading) {
        fetchFeed();
      }
    },
    [hasMore, isLoading, fetchFeed]
  );

  useEffect(() => {
    const element = loadMoreRef.current;
    if (!element) return;

    observerRef.current = new IntersectionObserver(handleObserver, {
      threshold: 0.1,
    });

    observerRef.current.observe(element);

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [handleObserver]);

  const handleDeletePost = async (postId: string) => {
    if (!confirm('Are you sure you want to delete this post?')) return;
    try {
      await postsApi.deletePost(postId);
      removePost(postId);
    } catch (error) {
      console.error('Failed to delete post:', error);
    }
  };

  return (
    <div className="max-w-2xl mx-auto py-6 px-4">
      {/* Post Composer */}
      <div className="mb-4">
        <PostComposer />
      </div>

      {/* Feed */}
      <div className="space-y-4">
        {posts.map((post) => (
          <PostCard
            key={post.id}
            post={post}
            onDelete={() => handleDeletePost(post.id)}
          />
        ))}

        {/* Loading indicator */}
        {isLoading && (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-facebook-blue" />
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="text-center py-8 text-red-500">
            <p>{error}</p>
            <button
              onClick={() => fetchFeed(true)}
              className="mt-2 text-facebook-blue hover:underline"
            >
              Try again
            </button>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && posts.length === 0 && !error && (
          <div className="text-center py-12">
            <div className="w-16 h-16 bg-gray-200 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-facebook-darkGray" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-facebook-text">No posts yet</h3>
            <p className="text-facebook-darkGray mt-1">
              Follow people to see their posts in your feed, or create your first post!
            </p>
          </div>
        )}

        {/* Infinite scroll trigger */}
        <div ref={loadMoreRef} className="h-10" />

        {/* End of feed */}
        {!hasMore && posts.length > 0 && (
          <div className="text-center py-8 text-facebook-darkGray">
            <p>You've seen all posts!</p>
          </div>
        )}
      </div>
    </div>
  );
}
