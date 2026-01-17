import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { feed, activities as activitiesApi } from '../services/api';
import { Activity } from '../types';
import { ActivityCard } from '../components/ActivityCard';
import { Link } from '@tanstack/react-router';

function Dashboard() {
  const { isAuthenticated, user } = useAuthStore();
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadFeed = async () => {
      try {
        setLoading(true);
        if (isAuthenticated) {
          const result = await feed.get({ limit: 20 });
          setActivities(result.activities);
        } else {
          const result = await feed.explore({ limit: 20 });
          setActivities(result.activities);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load feed');
      } finally {
        setLoading(false);
      }
    };

    loadFeed();
  }, [isAuthenticated]);

  const handleSimulateActivity = async () => {
    try {
      const result = await activitiesApi.simulate({
        type: Math.random() > 0.5 ? 'run' : 'ride',
        numPoints: 50 + Math.floor(Math.random() * 100),
      });
      setActivities((prev) => [result.activity, ...prev]);
    } catch (err) {
      console.error('Failed to simulate activity:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="text-strava-gray-600">Loading activities...</div>
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
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Main Feed */}
      <div className="lg:col-span-2">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-strava-gray-800">
            {isAuthenticated ? 'Your Feed' : 'Explore Activities'}
          </h1>
          {isAuthenticated && (
            <div className="flex gap-2">
              <button
                onClick={handleSimulateActivity}
                className="px-4 py-2 bg-strava-gray-200 text-strava-gray-700 rounded-lg hover:bg-strava-gray-300 text-sm"
              >
                Simulate Activity
              </button>
              <Link
                to="/upload"
                className="px-4 py-2 bg-strava-orange text-white rounded-lg hover:bg-strava-orange-dark text-sm"
              >
                Upload Activity
              </Link>
            </div>
          )}
        </div>

        {activities.length === 0 ? (
          <div className="bg-white rounded-lg shadow p-8 text-center">
            <div className="text-4xl mb-4">🏃</div>
            <h2 className="text-xl font-semibold text-strava-gray-800 mb-2">
              No activities yet
            </h2>
            <p className="text-strava-gray-600 mb-4">
              {isAuthenticated
                ? 'Upload your first activity or follow other athletes to see their activities here.'
                : 'Sign up to start tracking your activities!'}
            </p>
            {isAuthenticated && (
              <Link
                to="/upload"
                className="inline-block px-6 py-3 bg-strava-orange text-white rounded-lg hover:bg-strava-orange-dark"
              >
                Upload Your First Activity
              </Link>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {activities.map((activity) => (
              <ActivityCard key={activity.id} activity={activity} />
            ))}
          </div>
        )}
      </div>

      {/* Sidebar */}
      <div className="space-y-6">
        {isAuthenticated && user && (
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center mb-4">
              <div className="w-12 h-12 bg-strava-orange rounded-full flex items-center justify-center text-white text-xl font-bold">
                {user.username?.charAt(0).toUpperCase()}
              </div>
              <div className="ml-3">
                <div className="font-semibold text-strava-gray-800">
                  {user.username}
                </div>
                <Link
                  to="/stats"
                  className="text-sm text-strava-orange hover:underline"
                >
                  View Your Stats
                </Link>
              </div>
            </div>
          </div>
        )}

        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="font-semibold text-strava-gray-800 mb-3">
            Quick Links
          </h3>
          <div className="space-y-2">
            <Link
              to="/segments"
              className="block px-3 py-2 bg-strava-gray-50 rounded hover:bg-strava-gray-100 text-strava-gray-700"
            >
              Explore Segments
            </Link>
            <Link
              to="/explore"
              className="block px-3 py-2 bg-strava-gray-50 rounded hover:bg-strava-gray-100 text-strava-gray-700"
            >
              Discover Activities
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/')({
  component: Dashboard,
});
