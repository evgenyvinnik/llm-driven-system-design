import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { users } from '../services/api';
import { User } from '../types';

function Followers() {
  const { id } = Route.useParams();
  const [followers, setFollowers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadFollowers = async () => {
      try {
        setLoading(true);
        const data = await users.getFollowers(id);
        setFollowers(data.followers);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load followers');
      } finally {
        setLoading(false);
      }
    };

    loadFollowers();
  }, [id]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="text-strava-gray-600">Loading followers...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
        {error}
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-4 mb-6">
        <Link
          to={`/profile/${id}`}
          className="text-strava-gray-600 hover:text-strava-gray-800"
        >
          ← Back to Profile
        </Link>
        <h1 className="text-2xl font-bold text-strava-gray-800">Followers</h1>
      </div>

      {followers.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="text-4xl mb-4">👥</div>
          <p className="text-strava-gray-600">No followers yet.</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow divide-y divide-strava-gray-100">
          {followers.map((follower) => (
            <Link
              key={follower.id}
              to={`/profile/${follower.id}`}
              className="flex items-center p-4 hover:bg-strava-gray-50"
            >
              <div className="w-12 h-12 bg-strava-gray-200 rounded-full flex items-center justify-center text-lg font-bold">
                {follower.profilePhoto ? (
                  <img
                    src={follower.profilePhoto}
                    alt={follower.username}
                    className="w-12 h-12 rounded-full"
                  />
                ) : (
                  follower.username.charAt(0).toUpperCase()
                )}
              </div>
              <div className="ml-4">
                <div className="font-medium text-strava-gray-800">
                  {follower.username}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/profile/$id/followers')({
  component: Followers,
});
