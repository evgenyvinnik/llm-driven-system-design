import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { usersApi } from '../services/api';
import { User } from '../types';
import { formatNumber } from '../utils/format';

/**
 * Renders follow suggestions: accounts the current user does not already follow,
 * ranked by follower count.
 */
export function WhoToFollow() {
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    usersApi
      .getSuggestions(3)
      .then(({ users }) => setUsers(users))
      .catch(() => setUsers([]))
      .finally(() => setIsLoading(false));
  }, []);

  if (isLoading) {
    return (
      <div className="bg-twitter-background rounded-2xl p-4">
        <h2 className="text-xl font-extrabold text-twitter-dark">Who to follow</h2>
        <div className="animate-pulse space-y-4 mt-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-twitter-border" />
              <div className="space-y-2 flex-1">
                <div className="h-3 bg-twitter-border rounded w-24" />
                <div className="h-3 bg-twitter-border rounded w-16" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Everyone already followed is a legitimate state, not an error — showing an
  // empty panel is better than showing a permanent "suggestions will appear here".
  if (users.length === 0) return null;

  return (
    <div className="bg-twitter-background rounded-2xl">
      <h2 className="text-xl font-extrabold text-twitter-dark p-4 pb-2">Who to follow</h2>
      {users.map((user) => (
        <Link
          key={user.id}
          to="/$username"
          params={{ username: user.username }}
          className="flex items-center gap-3 px-4 py-3 hover:bg-black/5 transition-colors"
        >
          <div className="w-10 h-10 rounded-full bg-twitter-blue text-white flex items-center justify-center font-bold shrink-0">
            {user.displayName?.[0]?.toUpperCase() ?? user.username[0].toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-bold text-[15px] text-twitter-dark truncate">{user.displayName}</p>
            <p className="text-[13px] text-twitter-gray truncate">@{user.username}</p>
          </div>
          <span className="text-[13px] text-twitter-gray shrink-0">
            {formatNumber(user.followerCount ?? 0)}
          </span>
        </Link>
      ))}
    </div>
  );
}
