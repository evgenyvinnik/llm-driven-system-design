import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { User, Post } from '../types';
import api from '../services/api';
import { PostCard } from '../components/PostCard';
import { formatTimeAgo, formatNumber } from '../utils/format';

export const Route = createFileRoute('/u/$username')({
  component: UserProfilePage,
});

function UserProfilePage() {
  const { username } = Route.useParams();

  const [user, setUser] = useState<User | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIsLoading(true);
    setError(null);

    Promise.all([api.getUser(username), api.getUserPosts(username)])
      .then(([u, p]) => {
        setUser(u);
        setPosts(p);
      })
      .catch((err) => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [username]);

  if (isLoading) {
    return (
      <div className="bg-white rounded border border-gray-200 p-8 text-center text-gray-500">
        Loading profile...
      </div>
    );
  }

  if (error || !user) {
    return (
      <div className="bg-white rounded border border-gray-200 p-8 text-center text-red-500">
        {error || 'User not found'}
      </div>
    );
  }

  return (
    <div className="flex gap-6">
      <div className="flex-1">
        <h2 className="text-lg font-medium mb-4">Posts by u/{username}</h2>

        {posts.length === 0 ? (
          <div className="bg-white rounded border border-gray-200 p-8 text-center text-gray-500">
            No posts yet.
          </div>
        ) : (
          <div className="space-y-3">
            {posts.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
        )}
      </div>

      <aside className="w-80 hidden lg:block">
        <div className="bg-white rounded border border-gray-200 overflow-hidden">
          <div className="bg-reddit-blue h-16" />
          <div className="p-4 -mt-8">
            <div className="w-16 h-16 bg-gray-300 rounded-full border-4 border-white mb-2" />
            <h1 className="text-lg font-bold">u/{user.username}</h1>
            <p className="text-xs text-gray-500 mb-4">
              Joined {formatTimeAgo(user.created_at || new Date().toISOString())}
            </p>

            <div className="flex gap-4 text-sm border-t border-gray-200 pt-4">
              <div>
                <div className="font-bold">{formatNumber(user.karma_post)}</div>
                <div className="text-gray-500">Post Karma</div>
              </div>
              <div>
                <div className="font-bold">{formatNumber(user.karma_comment)}</div>
                <div className="text-gray-500">Comment Karma</div>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
