import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { activities as activitiesApi } from '../services/api';
import { Activity, GpsPoint, Comment } from '../types';
import { ActivityMap } from '../components/ActivityMap';
import {
  formatDuration,
  formatDistance,
  formatSpeed,
  formatElevation,
  formatDateTime,
  getActivityIcon,
} from '../utils/format';
import { useAuthStore } from '../stores/authStore';
import { Link } from '@tanstack/react-router';

function ActivityDetail() {
  const { id } = Route.useParams();
  const { isAuthenticated, user } = useAuthStore();
  const [activity, setActivity] = useState<Activity | null>(null);
  const [gpsPoints, setGpsPoints] = useState<GpsPoint[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasKudos, setHasKudos] = useState(false);
  const [kudosCount, setKudosCount] = useState(0);

  useEffect(() => {
    const loadActivity = async () => {
      try {
        setLoading(true);
        const [activityData, gpsData, commentsData] = await Promise.all([
          activitiesApi.get(id),
          activitiesApi.getGps(id).catch(() => ({ points: [] })),
          activitiesApi.getComments(id),
        ]);

        setActivity(activityData);
        setGpsPoints(gpsData.points);
        setComments(commentsData.comments);
        setHasKudos(activityData.hasKudos || false);
        setKudosCount(activityData.kudos_count || 0);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load activity');
      } finally {
        setLoading(false);
      }
    };

    loadActivity();
  }, [id]);

  const handleKudos = async () => {
    if (!isAuthenticated) return;

    try {
      if (hasKudos) {
        await activitiesApi.removeKudos(id);
        setHasKudos(false);
        setKudosCount((c) => c - 1);
      } else {
        await activitiesApi.kudos(id);
        setHasKudos(true);
        setKudosCount((c) => c + 1);
      }
    } catch (err) {
      console.error('Kudos error:', err);
    }
  };

  const handleAddComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim()) return;

    try {
      const result = await activitiesApi.addComment(id, newComment);
      setComments((prev) => [
        ...prev,
        { ...result.comment, username: user?.username || '', user_id: user?.id || '' },
      ]);
      setNewComment('');
    } catch (err) {
      console.error('Comment error:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="text-strava-gray-600">Loading activity...</div>
      </div>
    );
  }

  if (error || !activity) {
    return (
      <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
        {error || 'Activity not found'}
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="bg-white rounded-lg shadow mb-6">
        <div className="p-6">
          <div className="flex items-center mb-4">
            <Link
              to={`/profile/${activity.user_id}`}
              className="flex items-center hover:opacity-80"
            >
              <div className="w-12 h-12 bg-strava-gray-200 rounded-full flex items-center justify-center text-xl font-bold">
                {activity.profile_photo ? (
                  <img
                    src={activity.profile_photo}
                    alt={activity.username}
                    className="w-12 h-12 rounded-full"
                  />
                ) : (
                  activity.username?.charAt(0).toUpperCase()
                )}
              </div>
              <div className="ml-3">
                <div className="font-semibold text-strava-gray-800">
                  {activity.username}
                </div>
                <div className="text-sm text-strava-gray-500">
                  {formatDateTime(activity.start_time)}
                </div>
              </div>
            </Link>
          </div>

          <div className="flex items-center mb-4">
            <span className="text-3xl mr-3">{getActivityIcon(activity.type)}</span>
            <h1 className="text-2xl font-bold text-strava-gray-800">
              {activity.name}
            </h1>
          </div>

          {activity.description && (
            <p className="text-strava-gray-600 mb-4">{activity.description}</p>
          )}

          {/* Stats Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 py-4 border-t border-b border-strava-gray-100">
            <div>
              <div className="text-xs text-strava-gray-500 uppercase">Distance</div>
              <div className="text-2xl font-bold">
                {formatDistance(activity.distance)}
              </div>
            </div>
            <div>
              <div className="text-xs text-strava-gray-500 uppercase">Moving Time</div>
              <div className="text-2xl font-bold">
                {formatDuration(activity.moving_time)}
              </div>
            </div>
            <div>
              <div className="text-xs text-strava-gray-500 uppercase">Pace</div>
              <div className="text-2xl font-bold">
                {formatSpeed(activity.avg_speed || 0, activity.type)}
              </div>
            </div>
            <div>
              <div className="text-xs text-strava-gray-500 uppercase">Elevation</div>
              <div className="text-2xl font-bold">
                {formatElevation(activity.elevation_gain)}
              </div>
            </div>
          </div>

          {/* Additional Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 py-4">
            <div>
              <div className="text-xs text-strava-gray-500 uppercase">Elapsed Time</div>
              <div className="text-lg font-semibold">
                {formatDuration(activity.elapsed_time)}
              </div>
            </div>
            {activity.max_speed && (
              <div>
                <div className="text-xs text-strava-gray-500 uppercase">Max Speed</div>
                <div className="text-lg font-semibold">
                  {formatSpeed(activity.max_speed, activity.type)}
                </div>
              </div>
            )}
            {activity.avg_heart_rate && (
              <div>
                <div className="text-xs text-strava-gray-500 uppercase">Avg HR</div>
                <div className="text-lg font-semibold">{activity.avg_heart_rate} bpm</div>
              </div>
            )}
            {activity.calories && (
              <div>
                <div className="text-xs text-strava-gray-500 uppercase">Calories</div>
                <div className="text-lg font-semibold">{activity.calories}</div>
              </div>
            )}
          </div>

          {/* Kudos Button */}
          <div className="flex items-center gap-4 pt-4 border-t border-strava-gray-100">
            <button
              onClick={handleKudos}
              disabled={!isAuthenticated}
              className={`flex items-center space-x-2 px-4 py-2 rounded-full ${
                hasKudos
                  ? 'bg-strava-orange text-white'
                  : 'bg-strava-gray-100 text-strava-gray-600 hover:bg-strava-gray-200'
              } ${!isAuthenticated ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <span>{hasKudos ? '👏' : '👍'}</span>
              <span>{kudosCount} Kudos</span>
            </button>
          </div>
        </div>
      </div>

      {/* Map */}
      <div className="bg-white rounded-lg shadow mb-6 overflow-hidden">
        <ActivityMap
          encodedPolyline={activity.polyline}
          points={gpsPoints.length > 0 ? gpsPoints : undefined}
          activityType={activity.type}
          height="400px"
        />
      </div>

      {/* Segment Efforts */}
      {activity.segmentEfforts && activity.segmentEfforts.length > 0 && (
        <div className="bg-white rounded-lg shadow mb-6 p-6">
          <h2 className="text-xl font-bold text-strava-gray-800 mb-4">
            Segment Efforts
          </h2>
          <div className="space-y-3">
            {activity.segmentEfforts.map((effort) => (
              <Link
                key={effort.id}
                to={`/segment/${effort.segment_id}`}
                className="flex items-center justify-between p-3 bg-strava-gray-50 rounded-lg hover:bg-strava-gray-100"
              >
                <div>
                  <div className="font-medium">{effort.segment_name}</div>
                  <div className="text-sm text-strava-gray-500">
                    {formatDistance(effort.segment_distance || 0)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono font-bold">
                    {formatDuration(effort.elapsed_time)}
                  </div>
                  {effort.pr_rank && effort.pr_rank <= 3 && (
                    <div className="text-sm text-strava-orange">
                      #{effort.pr_rank} PR
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Comments */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-xl font-bold text-strava-gray-800 mb-4">
          Comments ({comments.length})
        </h2>

        {isAuthenticated && (
          <form onSubmit={handleAddComment} className="mb-6">
            <div className="flex gap-3">
              <input
                type="text"
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Add a comment..."
                className="flex-1 px-4 py-2 border border-strava-gray-300 rounded-lg focus:ring-2 focus:ring-strava-orange focus:border-transparent"
              />
              <button
                type="submit"
                disabled={!newComment.trim()}
                className="px-4 py-2 bg-strava-orange text-white rounded-lg hover:bg-strava-orange-dark disabled:opacity-50"
              >
                Post
              </button>
            </div>
          </form>
        )}

        {comments.length === 0 ? (
          <p className="text-strava-gray-500 text-center py-4">
            No comments yet. Be the first!
          </p>
        ) : (
          <div className="space-y-4">
            {comments.map((comment) => (
              <div key={comment.id} className="flex gap-3">
                <div className="w-8 h-8 bg-strava-gray-200 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0">
                  {comment.profile_photo ? (
                    <img
                      src={comment.profile_photo}
                      alt={comment.username}
                      className="w-8 h-8 rounded-full"
                    />
                  ) : (
                    comment.username.charAt(0).toUpperCase()
                  )}
                </div>
                <div>
                  <div className="font-medium text-sm">{comment.username}</div>
                  <div className="text-strava-gray-700">{comment.content}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/activity/$id')({
  component: ActivityDetail,
});
