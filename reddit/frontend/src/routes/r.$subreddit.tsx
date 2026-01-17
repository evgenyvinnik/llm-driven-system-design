import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { Post, Subreddit, SortType } from '../types';
import api from '../services/api';
import { PostCard } from '../components/PostCard';
import { SortTabs } from '../components/SortTabs';
import { formatNumber } from '../utils/format';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/r/$subreddit')({
  component: SubredditPage,
  validateSearch: (search: Record<string, unknown>): { sort?: SortType } => ({
    sort: (search.sort as SortType) || 'hot',
  }),
});

function SubredditPage() {
  const { subreddit } = Route.useParams();
  const { sort } = Route.useSearch();
  const user = useAuthStore((state) => state.user);

  const [subredditInfo, setSubredditInfo] = useState<Subreddit | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);

  useEffect(() => {
    setIsLoading(true);
    setError(null);

    Promise.all([
      api.getSubreddit(subreddit),
      api.getSubredditPosts(subreddit, sort || 'hot'),
    ])
      .then(([sub, postList]) => {
        setSubredditInfo(sub);
        setPosts(postList);
        setIsSubscribed(sub.subscribed || false);
      })
      .catch((err) => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [subreddit, sort]);

  const handleSubscribe = async () => {
    if (!user) return;

    try {
      if (isSubscribed) {
        await api.unsubscribe(subreddit);
        setIsSubscribed(false);
      } else {
        await api.subscribe(subreddit);
        setIsSubscribed(true);
      }
    } catch (err) {
      console.error('Subscription failed:', err);
    }
  };

  if (isLoading) {
    return (
      <div className="bg-white rounded border border-gray-200 p-8 text-center text-gray-500">
        Loading r/{subreddit}...
      </div>
    );
  }

  if (error || !subredditInfo) {
    return (
      <div className="bg-white rounded border border-gray-200 p-8 text-center text-red-500">
        {error || 'Subreddit not found'}
      </div>
    );
  }

  return (
    <div>
      {/* Subreddit header */}
      <div className="bg-reddit-blue h-20" />
      <div className="bg-white border-b border-gray-200 px-4 py-2">
        <div className="max-w-5xl mx-auto flex items-center gap-4">
          <div className="w-16 h-16 bg-reddit-blue rounded-full border-4 border-white -mt-8 flex items-center justify-center text-white text-2xl font-bold">
            r/
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold">{subredditInfo.title}</h1>
            <p className="text-sm text-gray-500">r/{subredditInfo.name}</p>
          </div>
          {user && (
            <button
              onClick={handleSubscribe}
              className={`px-4 py-1.5 rounded-full text-sm font-medium ${
                isSubscribed
                  ? 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-100'
                  : 'bg-reddit-blue text-white hover:bg-blue-700'
              }`}
            >
              {isSubscribed ? 'Joined' : 'Join'}
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-6 mt-4">
        <div className="flex-1">
          <SortTabs currentSort={sort || 'hot'} baseUrl={`/r/${subreddit}`} />

          {posts.length === 0 ? (
            <div className="bg-white rounded border border-gray-200 p-8 text-center text-gray-500">
              No posts in this subreddit yet.
              {user && (
                <Link
                  to="/submit"
                  search={{ subreddit }}
                  className="block mt-4 text-reddit-blue hover:underline"
                >
                  Be the first to post!
                </Link>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {posts.map((post) => (
                <PostCard key={post.id} post={post} />
              ))}
            </div>
          )}
        </div>

        {/* Subreddit sidebar */}
        <aside className="w-80 hidden lg:block">
          <div className="bg-white rounded border border-gray-200 overflow-hidden">
            <div className="bg-reddit-blue text-white px-4 py-3 font-medium">
              About Community
            </div>
            <div className="p-4">
              <p className="text-sm text-gray-700 mb-4">
                {subredditInfo.description || 'No description available.'}
              </p>
              <div className="flex gap-4 text-sm border-t border-gray-200 pt-4">
                <div>
                  <div className="font-bold">{formatNumber(subredditInfo.subscriber_count)}</div>
                  <div className="text-gray-500">Members</div>
                </div>
              </div>
              {user && (
                <Link
                  to="/submit"
                  search={{ subreddit }}
                  className="block w-full text-center py-1.5 mt-4 bg-reddit-blue text-white rounded-full text-sm font-medium hover:bg-blue-700"
                >
                  Create Post
                </Link>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
