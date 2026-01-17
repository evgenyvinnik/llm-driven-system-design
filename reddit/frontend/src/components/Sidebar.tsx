import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { Subreddit } from '../types';
import api from '../services/api';
import { formatNumber } from '../utils/format';

export function Sidebar() {
  const [subreddits, setSubreddits] = useState<Subreddit[]>([]);

  useEffect(() => {
    api.listSubreddits(10).then(setSubreddits).catch(console.error);
  }, []);

  return (
    <aside className="w-80 hidden lg:block">
      <div className="bg-white rounded border border-gray-200 overflow-hidden">
        <div className="bg-reddit-blue text-white px-4 py-3 font-medium">
          Popular Communities
        </div>
        <div className="p-4">
          <ul className="space-y-3">
            {subreddits.map((sub) => (
              <li key={sub.id}>
                <Link
                  to="/r/$subreddit"
                  params={{ subreddit: sub.name }}
                  className="flex items-center gap-3 hover:bg-gray-50 -mx-2 px-2 py-1 rounded"
                >
                  <div className="w-8 h-8 bg-reddit-blue rounded-full flex items-center justify-center text-white text-sm font-bold">
                    r/
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">r/{sub.name}</div>
                    <div className="text-xs text-gray-500">
                      {formatNumber(sub.subscriber_count)} members
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="bg-white rounded border border-gray-200 mt-4 p-4">
        <h3 className="font-medium mb-2">Create your own community</h3>
        <p className="text-sm text-gray-500 mb-3">
          Build your own online community around topics you care about.
        </p>
        <Link
          to="/subreddits/create"
          className="block w-full text-center py-1.5 border border-reddit-blue text-reddit-blue rounded-full text-sm font-medium hover:bg-blue-50"
        >
          Create Community
        </Link>
      </div>
    </aside>
  );
}
