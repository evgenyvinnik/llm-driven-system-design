import { Link } from '@tanstack/react-router';
import { Activity } from '../types';
import {
  formatDuration,
  formatDistance,
  formatSpeed,
  formatRelativeTime,
  getActivityIcon,
} from '../utils/format';
import { activities as activitiesApi } from '../services/api';
import { useState } from 'react';

interface ActivityCardProps {
  activity: Activity;
  onKudosChange?: () => void;
}

export function ActivityCard({ activity, onKudosChange }: ActivityCardProps) {
  const [hasKudos, setHasKudos] = useState(activity.hasKudos || false);
  const [kudosCount, setKudosCount] = useState(activity.kudos_count || 0);

  const handleKudos = async (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      if (hasKudos) {
        await activitiesApi.removeKudos(activity.id);
        setHasKudos(false);
        setKudosCount((c) => c - 1);
      } else {
        await activitiesApi.kudos(activity.id);
        setHasKudos(true);
        setKudosCount((c) => c + 1);
      }
      onKudosChange?.();
    } catch (error) {
      console.error('Kudos error:', error);
    }
  };

  return (
    <Link
      to={`/activity/${activity.id}`}
      className="block bg-white rounded-lg shadow hover:shadow-md transition-shadow"
    >
      <div className="p-4">
        {/* Header */}
        <div className="flex items-center mb-3">
          <div className="w-10 h-10 bg-strava-gray-200 rounded-full flex items-center justify-center text-lg font-bold">
            {activity.profile_photo ? (
              <img
                src={activity.profile_photo}
                alt={activity.username}
                className="w-10 h-10 rounded-full"
              />
            ) : (
              activity.username?.charAt(0).toUpperCase()
            )}
          </div>
          <div className="ml-3">
            <div className="font-medium text-strava-gray-800">
              {activity.username}
            </div>
            <div className="text-sm text-strava-gray-500">
              {formatRelativeTime(activity.start_time)}
            </div>
          </div>
        </div>

        {/* Activity Info */}
        <div className="flex items-center mb-2">
          <span className="text-2xl mr-2">{getActivityIcon(activity.type)}</span>
          <h3 className="text-lg font-semibold text-strava-gray-800">
            {activity.name}
          </h3>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-3 gap-4 py-3 border-t border-b border-strava-gray-100">
          <div>
            <div className="text-xs text-strava-gray-500 uppercase">Distance</div>
            <div className="text-lg font-semibold">
              {formatDistance(activity.distance)}
            </div>
          </div>
          <div>
            <div className="text-xs text-strava-gray-500 uppercase">Time</div>
            <div className="text-lg font-semibold">
              {formatDuration(activity.moving_time)}
            </div>
          </div>
          <div>
            <div className="text-xs text-strava-gray-500 uppercase">Pace</div>
            <div className="text-lg font-semibold">
              {formatSpeed(activity.avg_speed || 0, activity.type)}
            </div>
          </div>
        </div>

        {/* Elevation */}
        {activity.elevation_gain > 0 && (
          <div className="text-sm text-strava-gray-600 mt-2">
            Elevation: {Math.round(activity.elevation_gain)}m
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-strava-gray-100">
          <button
            onClick={handleKudos}
            className={`flex items-center space-x-1 px-3 py-1 rounded-full text-sm ${
              hasKudos
                ? 'bg-strava-orange text-white'
                : 'bg-strava-gray-100 text-strava-gray-600 hover:bg-strava-gray-200'
            }`}
          >
            <span>{hasKudos ? '👏' : '👍'}</span>
            <span>{kudosCount}</span>
          </button>
          <div className="flex items-center space-x-1 text-strava-gray-500 text-sm">
            <span>💬</span>
            <span>{activity.comment_count}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
