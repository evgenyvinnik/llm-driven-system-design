import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { segments as segmentsApi } from '../services/api';
import { Segment } from '../types';
import { ActivityMap } from '../components/ActivityMap';
import { LeaderboardTable } from '../components/LeaderboardTable';
import { formatDistance, formatElevation, formatDuration } from '../utils/format';
import { useAuthStore } from '../stores/authStore';

function SegmentDetail() {
  const { id } = Route.useParams();
  const { user } = useAuthStore();
  const [segment, setSegment] = useState<Segment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [leaderboardFilter, setLeaderboardFilter] = useState<'overall' | 'friends'>('overall');

  useEffect(() => {
    const loadSegment = async () => {
      try {
        setLoading(true);
        const data = await segmentsApi.get(id);
        setSegment(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load segment');
      } finally {
        setLoading(false);
      }
    };

    loadSegment();
  }, [id]);

  const handleFilterChange = async (filter: 'overall' | 'friends') => {
    setLeaderboardFilter(filter);
    try {
      const result = await segmentsApi.getLeaderboard(id, { filter });
      if (segment) {
        setSegment({ ...segment, leaderboard: result.leaderboard });
      }
    } catch (err) {
      console.error('Failed to load leaderboard:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="text-strava-gray-600">Loading segment...</div>
      </div>
    );
  }

  if (error || !segment) {
    return (
      <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
        {error || 'Segment not found'}
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="bg-white rounded-lg shadow mb-6 p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-strava-gray-800">{segment.name}</h1>
            <p className="text-strava-gray-500">
              Created by {segment.creator_name}
            </p>
          </div>
          <span className="px-3 py-1 bg-strava-gray-100 rounded-full text-sm capitalize">
            {segment.activity_type}
          </span>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 py-4 border-t border-b border-strava-gray-100">
          <div>
            <div className="text-xs text-strava-gray-500 uppercase">Distance</div>
            <div className="text-2xl font-bold">{formatDistance(segment.distance)}</div>
          </div>
          <div>
            <div className="text-xs text-strava-gray-500 uppercase">Elevation Gain</div>
            <div className="text-2xl font-bold">
              {formatElevation(segment.elevation_gain || 0)}
            </div>
          </div>
          <div>
            <div className="text-xs text-strava-gray-500 uppercase">Athletes</div>
            <div className="text-2xl font-bold">{segment.athlete_count}</div>
          </div>
          <div>
            <div className="text-xs text-strava-gray-500 uppercase">Efforts</div>
            <div className="text-2xl font-bold">{segment.effort_count}</div>
          </div>
        </div>

        {/* Your Best */}
        {segment.userRank && (
          <div className="mt-4 p-4 bg-strava-orange bg-opacity-10 rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-strava-gray-600">Your Best Time</div>
                <div className="text-2xl font-bold font-mono">
                  {formatDuration(segment.userRank.elapsedTime)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm text-strava-gray-600">Rank</div>
                <div className="text-2xl font-bold text-strava-orange">
                  #{segment.userRank.rank}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Map */}
      <div className="bg-white rounded-lg shadow mb-6 overflow-hidden">
        <ActivityMap
          encodedPolyline={segment.polyline}
          activityType={segment.activity_type}
          height="300px"
        />
      </div>

      {/* Leaderboard */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-strava-gray-800">Leaderboard</h2>
          <div className="flex gap-2">
            <button
              onClick={() => handleFilterChange('overall')}
              className={`px-3 py-1 rounded text-sm ${
                leaderboardFilter === 'overall'
                  ? 'bg-strava-orange text-white'
                  : 'bg-strava-gray-100 text-strava-gray-700'
              }`}
            >
              Overall
            </button>
            <button
              onClick={() => handleFilterChange('friends')}
              className={`px-3 py-1 rounded text-sm ${
                leaderboardFilter === 'friends'
                  ? 'bg-strava-orange text-white'
                  : 'bg-strava-gray-100 text-strava-gray-700'
              }`}
            >
              Friends
            </button>
          </div>
        </div>

        <LeaderboardTable
          entries={segment.leaderboard || []}
          currentUserId={user?.id}
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute('/segment/$id')({
  component: SegmentDetail,
});
