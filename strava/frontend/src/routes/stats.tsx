import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { stats } from '../services/api';
import { UserStats, Achievement } from '../types';
import { useAuthStore } from '../stores/authStore';
import { formatDistance, formatDuration } from '../utils/format';

function StatsPage() {
  const { isAuthenticated, user } = useAuthStore();
  const [userStats, setUserStats] = useState<UserStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadStats = async () => {
      if (!isAuthenticated) return;

      try {
        setLoading(true);
        const data = await stats.me();
        setUserStats(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load stats');
      } finally {
        setLoading(false);
      }
    };

    loadStats();
  }, [isAuthenticated]);

  if (!isAuthenticated) {
    return (
      <div className="max-w-2xl mx-auto mt-12 text-center">
        <h1 className="text-2xl font-bold text-strava-gray-800 mb-4">
          Please log in to view your stats
        </h1>
        <Link
          to="/login"
          className="inline-block px-6 py-3 bg-strava-orange text-white rounded-lg hover:bg-strava-orange-dark"
        >
          Log In
        </Link>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="text-strava-gray-600">Loading stats...</div>
      </div>
    );
  }

  if (error || !userStats) {
    return (
      <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
        {error || 'Failed to load stats'}
      </div>
    );
  }

  const { overall, byType, weekly, segments, kudosReceived, achievements } = userStats;

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-strava-gray-800 mb-6">
        Your Stats, {user?.username}
      </h1>

      {/* Overall Stats */}
      <div className="bg-white rounded-lg shadow mb-6 p-6">
        <h2 className="text-lg font-semibold text-strava-gray-800 mb-4">
          All-Time Stats
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="text-center p-4 bg-strava-gray-50 rounded-lg">
            <div className="text-3xl font-bold text-strava-orange">
              {overall.total_activities}
            </div>
            <div className="text-sm text-strava-gray-600">Activities</div>
          </div>
          <div className="text-center p-4 bg-strava-gray-50 rounded-lg">
            <div className="text-3xl font-bold text-strava-orange">
              {formatDistance(parseFloat(String(overall.total_distance)))}
            </div>
            <div className="text-sm text-strava-gray-600">Total Distance</div>
          </div>
          <div className="text-center p-4 bg-strava-gray-50 rounded-lg">
            <div className="text-3xl font-bold text-strava-orange">
              {formatDuration(parseInt(String(overall.total_time)))}
            </div>
            <div className="text-sm text-strava-gray-600">Total Time</div>
          </div>
          <div className="text-center p-4 bg-strava-gray-50 rounded-lg">
            <div className="text-3xl font-bold text-strava-orange">
              {Math.round(parseFloat(String(overall.total_elevation)))}m
            </div>
            <div className="text-sm text-strava-gray-600">Total Elevation</div>
          </div>
        </div>
      </div>

      {/* Stats by Activity Type */}
      {byType.length > 0 && (
        <div className="bg-white rounded-lg shadow mb-6 p-6">
          <h2 className="text-lg font-semibold text-strava-gray-800 mb-4">
            By Activity Type
          </h2>
          <div className="space-y-4">
            {byType.map((stat) => (
              <div
                key={stat.type}
                className="flex items-center justify-between p-3 bg-strava-gray-50 rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <span className="text-2xl">
                    {stat.type === 'run'
                      ? '🏃'
                      : stat.type === 'ride'
                      ? '🚴'
                      : stat.type === 'hike'
                      ? '🥾'
                      : '🏃'}
                  </span>
                  <div>
                    <div className="font-medium capitalize">{stat.type}</div>
                    <div className="text-sm text-strava-gray-500">
                      {stat.activity_count} activities
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold">
                    {formatDistance(parseFloat(String(stat.total_distance)))}
                  </div>
                  <div className="text-sm text-strava-gray-500">
                    {formatDuration(parseInt(String(stat.total_time)))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Segment Stats */}
      <div className="bg-white rounded-lg shadow mb-6 p-6">
        <h2 className="text-lg font-semibold text-strava-gray-800 mb-4">
          Segment Performance
        </h2>
        <div className="grid grid-cols-3 gap-4 text-center">
          <div className="p-4 bg-strava-gray-50 rounded-lg">
            <div className="text-2xl font-bold">{segments.total_efforts}</div>
            <div className="text-sm text-strava-gray-600">Total Efforts</div>
          </div>
          <div className="p-4 bg-strava-gray-50 rounded-lg">
            <div className="text-2xl font-bold">{segments.unique_segments}</div>
            <div className="text-sm text-strava-gray-600">Unique Segments</div>
          </div>
          <div className="p-4 bg-strava-gray-50 rounded-lg">
            <div className="text-2xl font-bold text-yellow-500">
              {segments.podium_finishes}
            </div>
            <div className="text-sm text-strava-gray-600">Podium Finishes</div>
          </div>
        </div>

        <div className="mt-4 text-center">
          <div className="text-lg">
            Total Kudos Received:{' '}
            <span className="font-bold text-strava-orange">{kudosReceived}</span>
          </div>
        </div>
      </div>

      {/* Weekly Progress */}
      {weekly.length > 0 && (
        <div className="bg-white rounded-lg shadow mb-6 p-6">
          <h2 className="text-lg font-semibold text-strava-gray-800 mb-4">
            Weekly Activity (Last 4 Weeks)
          </h2>
          <div className="space-y-3">
            {weekly.map((week) => (
              <div
                key={week.week}
                className="flex items-center justify-between p-3 bg-strava-gray-50 rounded-lg"
              >
                <div className="text-sm text-strava-gray-600">
                  Week of {new Date(week.week).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </div>
                <div className="flex gap-4 text-sm">
                  <span>{week.activity_count} activities</span>
                  <span className="font-semibold">
                    {formatDistance(parseFloat(String(week.total_distance)))}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Achievements */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-strava-gray-800 mb-4">
          Achievements
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {achievements.map((achievement: Achievement) => (
            <div
              key={achievement.id}
              className={`p-4 rounded-lg text-center ${
                achievement.earned
                  ? 'bg-yellow-50 border-2 border-yellow-300'
                  : 'bg-strava-gray-50 opacity-50'
              }`}
            >
              <div className="text-3xl mb-2">
                {achievement.icon === 'trophy'
                  ? '🏆'
                  : achievement.icon === 'star'
                  ? '⭐'
                  : achievement.icon === 'medal'
                  ? '🏅'
                  : achievement.icon === 'running'
                  ? '🏃'
                  : achievement.icon === 'bike'
                  ? '🚴'
                  : achievement.icon === 'mountain'
                  ? '⛰️'
                  : achievement.icon === 'target'
                  ? '🎯'
                  : achievement.icon === 'heart'
                  ? '❤️'
                  : '🏆'}
              </div>
              <div className="font-medium text-sm">{achievement.name}</div>
              {achievement.earned && (
                <div className="text-xs text-strava-orange mt-1">Earned!</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/stats')({
  component: StatsPage,
});
