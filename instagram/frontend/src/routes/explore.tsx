import { useState, useEffect } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { feedApi, usersApi } from '../services/api';
import type { PostThumbnail, User } from '../types';
import { PostGrid } from '../components/PostGrid';
import { Avatar } from '../components/Avatar';
import { Link } from '@tanstack/react-router';

export const Route = createFileRoute('/explore')({
  component: ExplorePage,
});

function ExplorePage() {
  const [posts, setPosts] = useState<PostThumbnail[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  useEffect(() => {
    loadExplore();
  }, []);

  useEffect(() => {
    if (searchQuery.length >= 2) {
      const timer = setTimeout(() => {
        searchUsers();
      }, 300);
      return () => clearTimeout(timer);
    } else {
      setSearchResults([]);
    }
  }, [searchQuery]);

  const loadExplore = async (cursor?: string) => {
    try {
      setLoading(true);
      const response = await feedApi.getExplore(cursor);
      if (cursor) {
        setPosts((prev) => [...prev, ...response.posts]);
      } else {
        setPosts(response.posts);
      }
      setNextCursor(response.nextCursor);
    } catch (error) {
      console.error('Error loading explore:', error);
    } finally {
      setLoading(false);
    }
  };

  const searchUsers = async () => {
    try {
      setSearchLoading(true);
      const response = await usersApi.search(searchQuery);
      setSearchResults(response.users);
    } catch (error) {
      console.error('Error searching users:', error);
    } finally {
      setSearchLoading(false);
    }
  };

  return (
    <div>
      {/* Search bar */}
      <div className="relative mb-6">
        <input
          type="text"
          placeholder="Search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-4 py-2 bg-gray-100 rounded-lg outline-none focus:bg-white focus:ring-1 focus:ring-border-gray"
        />
        <svg
          className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-text-gray"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>

        {/* Search results dropdown */}
        {searchQuery.length >= 2 && (
          <div className="absolute top-full left-0 right-0 bg-white border border-border-gray rounded-lg mt-1 shadow-lg z-10 max-h-80 overflow-y-auto">
            {searchLoading ? (
              <div className="p-4 text-center text-text-gray">Searching...</div>
            ) : searchResults.length === 0 ? (
              <div className="p-4 text-center text-text-gray">No results found</div>
            ) : (
              searchResults.map((user) => (
                <Link
                  key={user.id}
                  to="/profile/$username"
                  params={{ username: user.username }}
                  className="flex items-center gap-3 p-3 hover:bg-gray-50"
                  onClick={() => setSearchQuery('')}
                >
                  <Avatar src={user.profilePictureUrl} alt={user.username} size="md" />
                  <div>
                    <p className="font-semibold text-sm">{user.username}</p>
                    <p className="text-sm text-text-gray">{user.displayName}</p>
                  </div>
                </Link>
              ))
            )}
          </div>
        )}
      </div>

      {/* Explore grid */}
      <PostGrid posts={posts} loading={loading && posts.length === 0} />

      {/* Load more */}
      {nextCursor && posts.length > 0 && (
        <button
          onClick={() => loadExplore(nextCursor)}
          disabled={loading}
          className="w-full py-3 mt-4 text-primary font-semibold disabled:opacity-50"
        >
          {loading ? 'Loading...' : 'Load more'}
        </button>
      )}
    </div>
  );
}
