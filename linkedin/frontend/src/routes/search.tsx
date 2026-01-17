import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { usersApi } from '../services/api';
import type { User } from '../types';
import { Search } from 'lucide-react';

export const Route = createFileRoute('/search')({
  component: SearchPage,
  validateSearch: (search: Record<string, unknown>) => ({
    q: (search.q as string) || '',
  }),
});

function SearchPage() {
  const { q } = Route.useSearch();
  const { isAuthenticated } = useAuthStore();
  const navigate = useNavigate();

  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState(q);

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }

    if (!q) {
      setLoading(false);
      return;
    }

    const search = async () => {
      setLoading(true);
      try {
        const { users: results } = await usersApi.search(q);
        setUsers(results);
      } catch (error) {
        console.error('Search failed:', error);
      }
      setLoading(false);
    };

    search();
  }, [q, isAuthenticated, navigate]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    navigate({ to: '/search', search: { q: searchQuery } });
  };

  if (!isAuthenticated) return null;

  return (
    <main className="max-w-4xl mx-auto px-4 py-6">
      <div className="card p-4 mb-6">
        <form onSubmit={handleSearch} className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search people by name, headline, or skills"
              className="input pl-10"
            />
          </div>
          <button type="submit" className="btn-primary">
            Search
          </button>
        </form>
      </div>

      {loading ? (
        <div className="card p-8 text-center text-gray-500">Searching...</div>
      ) : !q ? (
        <div className="card p-8 text-center text-gray-500">
          Enter a search term to find people
        </div>
      ) : users.length === 0 ? (
        <div className="card p-8 text-center text-gray-500">
          No results found for "{q}"
        </div>
      ) : (
        <div className="card">
          <div className="p-4 border-b">
            <h2 className="font-semibold">{users.length} results for "{q}"</h2>
          </div>
          <div className="divide-y">
            {users.map((user) => (
              <Link
                key={user.id}
                to="/profile/$userId"
                params={{ userId: String(user.id) }}
                className="flex items-center gap-4 p-4 hover:bg-gray-50"
              >
                <div className="w-16 h-16 rounded-full bg-gray-300 flex items-center justify-center text-xl font-bold flex-shrink-0">
                  {user.profile_image_url ? (
                    <img
                      src={user.profile_image_url}
                      alt={user.first_name}
                      className="w-full h-full rounded-full object-cover"
                    />
                  ) : (
                    user.first_name?.[0]
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold hover:text-linkedin-blue hover:underline">
                    {user.first_name} {user.last_name}
                  </div>
                  <div className="text-sm text-gray-600 truncate">{user.headline}</div>
                  <div className="text-sm text-gray-500">{user.location}</div>
                </div>
                <button className="btn-secondary text-sm">Connect</button>
              </Link>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
