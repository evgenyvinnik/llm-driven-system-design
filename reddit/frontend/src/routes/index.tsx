import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { Post, SortType } from '../types';
import api from '../services/api';
import { PostCard } from '../components/PostCard';
import { SortTabs } from '../components/SortTabs';
import { Sidebar } from '../components/Sidebar';

export const Route = createFileRoute('/')({
  component: HomePage,
  validateSearch: (search: Record<string, unknown>): { sort?: SortType } => ({
    sort: (search.sort as SortType) || 'hot',
  }),
});

function HomePage() {
  const { sort } = Route.useSearch();
  const [posts, setPosts] = useState<Post[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIsLoading(true);
    setError(null);
    api
      .listPosts(sort || 'hot')
      .then(setPosts)
      .catch((err) => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [sort]);

  return (
    <div className="flex gap-6">
      <div className="flex-1">
        <SortTabs currentSort={sort || 'hot'} baseUrl="/" />

        {isLoading ? (
          <div className="bg-white rounded border border-gray-200 p-8 text-center text-gray-500">
            Loading posts...
          </div>
        ) : error ? (
          <div className="bg-white rounded border border-gray-200 p-8 text-center text-red-500">
            {error}
          </div>
        ) : posts.length === 0 ? (
          <div className="bg-white rounded border border-gray-200 p-8 text-center text-gray-500">
            No posts yet. Be the first to create one!
          </div>
        ) : (
          <div className="space-y-3">
            {posts.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
        )}
      </div>

      <Sidebar />
    </div>
  );
}
