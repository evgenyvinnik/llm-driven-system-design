import { Link } from '@tanstack/react-router';
import { Segment } from '../types';
import { formatDistance, formatDuration } from '../utils/format';

interface SegmentCardProps {
  segment: Segment;
}

export function SegmentCard({ segment }: SegmentCardProps) {
  return (
    <Link
      to={`/segment/${segment.id}`}
      className="block bg-white rounded-lg shadow hover:shadow-md transition-shadow p-4"
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold text-strava-gray-800">
            {segment.name}
          </h3>
          <div className="text-sm text-strava-gray-500 mt-1">
            Created by {segment.creator_name}
          </div>
        </div>
        <span className="px-2 py-1 bg-strava-gray-100 rounded text-sm capitalize">
          {segment.activity_type}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-4 mt-4">
        <div>
          <div className="text-xs text-strava-gray-500 uppercase">Distance</div>
          <div className="text-lg font-semibold">
            {formatDistance(segment.distance)}
          </div>
        </div>
        <div>
          <div className="text-xs text-strava-gray-500 uppercase">Elevation</div>
          <div className="text-lg font-semibold">
            {Math.round(segment.elevation_gain || 0)}m
          </div>
        </div>
        <div>
          <div className="text-xs text-strava-gray-500 uppercase">Athletes</div>
          <div className="text-lg font-semibold">{segment.athlete_count}</div>
        </div>
      </div>

      {segment.userRank && (
        <div className="mt-3 pt-3 border-t border-strava-gray-100">
          <div className="flex items-center justify-between text-sm">
            <span className="text-strava-gray-600">Your Best</span>
            <span className="font-semibold">
              {formatDuration(segment.userRank.elapsedTime)} (#{segment.userRank.rank})
            </span>
          </div>
        </div>
      )}
    </Link>
  );
}
