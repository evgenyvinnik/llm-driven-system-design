import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { feed } from '../services/api';
import { Activity } from '../types';
import { ActivityCard } from '../components/ActivityCard';

function Explore() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    const loadActivities = async () => {
      try {
        setLoading(true);
        const result = await feed.explore({
          limit: 30,
          type: filter === 'all' ? undefined : filter,
        });
        setActivities(result.activities);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load activities');
      } finally {
        setLoading(false);
      }
    };

    loadActivities();
  }, [filter]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-strava-gray-800">Explore Activities</h1>
        <div className="flex gap-2">
          {['all', 'run', 'ride', 'hike'].map((type) => (
            <button
              key={type}
              onClick={() => setFilter(type)}
              className={`px-4 py-2 rounded-lg text-sm font-medium capitalize ${
                filter === type
                  ? 'bg-strava-orange text-white'
                  : 'bg-strava-gray-100 text-strava-gray-700 hover:bg-strava-gray-200'
              }`}
            >
              {type}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="text-strava-gray-600">Loading activities...</div>
        </div>
      ) : error ? (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      ) : activities.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="text-4xl mb-4">🔍</div>
          <h2 className="text-xl font-semibold text-strava-gray-800 mb-2">
            No activities found
          </h2>
          <p className="text-strava-gray-600">
            Try a different filter or check back later.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {activities.map((activity) => (
            <ActivityCard key={activity.id} activity={activity} />
          ))}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/explore')({
  component: Explore,
});
