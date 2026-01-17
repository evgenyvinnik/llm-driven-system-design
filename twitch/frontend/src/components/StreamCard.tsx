import { Link } from '@tanstack/react-router';
import type { Channel } from '../types';

interface StreamCardProps {
  channel: Channel;
}

export function StreamCard({ channel }: StreamCardProps) {
  return (
    <Link
      to={`/${channel.name}`}
      className="stream-card block group"
    >
      {/* Thumbnail */}
      <div className="relative aspect-video bg-surface-light rounded-lg overflow-hidden mb-2 stream-thumbnail">
        {/* Placeholder thumbnail with gradient */}
        <div className="absolute inset-0 bg-gradient-to-br from-twitch-600 to-twitch-800 flex items-center justify-center">
          <span className="text-4xl font-bold text-white/50">
            {channel.user.displayName?.[0] || channel.name[0].toUpperCase()}
          </span>
        </div>

        {/* Live indicator */}
        {channel.isLive && (
          <div className="absolute top-2 left-2">
            <span className="live-indicator">LIVE</span>
          </div>
        )}

        {/* Viewer count */}
        {channel.isLive && (
          <div className="absolute bottom-2 left-2 bg-black/70 px-2 py-0.5 rounded text-xs text-white">
            {formatViewerCount(channel.viewerCount)} viewers
          </div>
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <div className="bg-twitch-500 px-4 py-2 rounded font-semibold text-white">
            Watch Now
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="flex gap-3">
        {/* Avatar */}
        <div className="flex-shrink-0">
          <div className="w-10 h-10 rounded-full bg-twitch-500 flex items-center justify-center text-white font-bold">
            {channel.user.displayName?.[0]?.toUpperCase() || channel.user.username[0].toUpperCase()}
          </div>
        </div>

        {/* Details */}
        <div className="flex-1 min-w-0">
          <h3 className="text-white font-semibold text-sm truncate group-hover:text-twitch-400">
            {channel.title}
          </h3>
          <p className="text-gray-400 text-sm truncate">
            {channel.user.displayName || channel.user.username}
          </p>
          {channel.category && (
            <p className="text-gray-400 text-sm truncate hover:text-twitch-400">
              {channel.category.name}
            </p>
          )}
        </div>
      </div>
    </Link>
  );
}

function formatViewerCount(count: number): string {
  if (count >= 1000000) {
    return (count / 1000000).toFixed(1) + 'M';
  }
  if (count >= 1000) {
    return (count / 1000).toFixed(1) + 'K';
  }
  return count.toString();
}
