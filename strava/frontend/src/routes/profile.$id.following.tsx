import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { users } from '../services/api';
import { User } from '../types';

function Following() {
  const { id } = Route.useParams();
  const [following, setFollowing] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadFollowing = async () => {
      try {
        setLoading(true);
        const data = await users.getFollowing(id);
        setFollowing(data.following);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load following');
      } finally {
        setLoading(false);
      }
    };

    loadFollowing();
  }, [id]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="text-strava-gray-600">Loading following...</div>
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
        <h1 className="text-2xl font-bold text-strava-gray-800">Following</h1>
      </div>

      {following.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="text-4xl mb-4">👥</div>
          <p className="text-strava-gray-600">Not following anyone yet.</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow divide-y divide-strava-gray-100">
          {following.map((user) => (
            <Link
              key={user.id}
              to={`/profile/${user.id}`}
              className="flex items-center p-4 hover:bg-strava-gray-50"
            >
              <div className="w-12 h-12 bg-strava-gray-200 rounded-full flex items-center justify-center text-lg font-bold">
                {user.profilePhoto ? (
                  <img
                    src={user.profilePhoto}
                    alt={user.username}
                    className="w-12 h-12 rounded-full"
                  />
                ) : (
                  user.username.charAt(0).toUpperCase()
                )}
              </div>
              <div className="ml-4">
                <div className="font-medium text-strava-gray-800">
                  {user.username}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/profile/$id/following')({
  component: Following,
});
