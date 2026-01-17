import type { Video } from '../types';
import { recordView } from '../services/api';

interface VideoCardProps {
  video: Video;
  rank: number;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatViews(views: number): string {
  if (views >= 1000000) {
    return `${(views / 1000000).toFixed(1)}M views`;
  }
  if (views >= 1000) {
    return `${(views / 1000).toFixed(1)}K views`;
  }
  return `${views} views`;
}

function formatWindowViews(views: number): string {
  if (views >= 1000) {
    return `${(views / 1000).toFixed(1)}K`;
  }
  return String(views);
}

function getRankBadgeColor(rank: number): string {
  if (rank === 1) return 'bg-yellow-500';
  if (rank === 2) return 'bg-gray-400';
  if (rank === 3) return 'bg-amber-600';
  return 'bg-youtube-gray';
}

export function VideoCard({ video, rank }: VideoCardProps) {
  const handleClick = async () => {
    try {
      await recordView(video.id);
    } catch (error) {
      console.error('Failed to record view:', error);
    }
  };

  return (
    <div
      onClick={handleClick}
      className="flex gap-4 p-3 rounded-lg hover:bg-youtube-gray cursor-pointer transition-colors group"
    >
      {/* Rank Badge */}
      <div className="flex-shrink-0 flex items-start pt-2">
        <span
          className={`w-8 h-8 flex items-center justify-center rounded-full font-bold text-sm ${getRankBadgeColor(
            rank
          )}`}
        >
          {rank}
        </span>
      </div>

      {/* Thumbnail */}
      <div className="relative flex-shrink-0">
        <img
          src={video.thumbnail_url}
          alt={video.title}
          className="w-40 h-24 object-cover rounded-lg"
        />
        <span className="absolute bottom-1 right-1 bg-black/80 text-white text-xs px-1 rounded">
          {formatDuration(video.duration_seconds)}
        </span>
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h3 className="font-medium text-white line-clamp-2 group-hover:text-youtube-red transition-colors">
          {video.title}
        </h3>
        <p className="text-sm text-gray-400 mt-1">{video.channel_name}</p>
        <div className="flex items-center gap-2 mt-1 text-sm text-gray-400">
          <span>{formatViews(video.total_views)}</span>
          <span>•</span>
          <span className="capitalize">{video.category}</span>
        </div>
      </div>

      {/* Window Views */}
      {video.windowViews !== undefined && video.windowViews > 0 && (
        <div className="flex-shrink-0 flex flex-col items-end justify-center">
          <div className="text-youtube-red font-bold text-lg">
            +{formatWindowViews(video.windowViews)}
          </div>
          <div className="text-xs text-gray-500">last hour</div>
        </div>
      )}
    </div>
  );
}
