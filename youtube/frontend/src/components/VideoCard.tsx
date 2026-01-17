import { Link } from '@tanstack/react-router';
import { Video } from '../types';
import { formatDuration, formatViewCount, timeAgo, getPlaceholderThumbnail, getAvatarUrl } from '../utils/format';

interface VideoCardProps {
  video: Video;
  layout?: 'grid' | 'list';
}

export default function VideoCard({ video, layout = 'grid' }: VideoCardProps) {
  const thumbnailUrl = video.thumbnailUrl || getPlaceholderThumbnail(video.title);

  if (layout === 'list') {
    return (
      <Link
        to="/watch/$videoId"
        params={{ videoId: video.id }}
        className="flex gap-4 p-2 hover:bg-yt-dark-hover rounded-lg"
      >
        {/* Thumbnail */}
        <div className="video-thumbnail w-40 flex-shrink-0">
          <img
            src={thumbnailUrl}
            alt={video.title}
            className="w-full h-full object-cover"
          />
          {video.duration && (
            <span className="video-duration">{formatDuration(video.duration)}</span>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-sm line-clamp-2 mb-1">{video.title}</h3>
          {video.channel && (
            <p className="text-xs text-gray-400">{video.channel.name}</p>
          )}
          <p className="text-xs text-gray-400">
            {formatViewCount(video.viewCount)} - {timeAgo(video.publishedAt)}
          </p>
        </div>
      </Link>
    );
  }

  return (
    <div className="group">
      {/* Thumbnail */}
      <Link to="/watch/$videoId" params={{ videoId: video.id }}>
        <div className="video-thumbnail">
          <img
            src={thumbnailUrl}
            alt={video.title}
            className="w-full h-full object-cover"
          />
          {video.duration && (
            <span className="video-duration">{formatDuration(video.duration)}</span>
          )}
        </div>
      </Link>

      {/* Info */}
      <div className="flex gap-3 mt-3">
        {/* Channel avatar */}
        {video.channel && (
          <Link to="/channel/$channelId" params={{ channelId: video.channel.id }}>
            <img
              src={getAvatarUrl(video.channel.avatarUrl, video.channel.username)}
              alt={video.channel.name}
              className="w-9 h-9 rounded-full flex-shrink-0"
            />
          </Link>
        )}

        {/* Text info */}
        <div className="flex-1 min-w-0">
          <Link to="/watch/$videoId" params={{ videoId: video.id }}>
            <h3 className="font-medium text-sm line-clamp-2 mb-1 group-hover:text-white">
              {video.title}
            </h3>
          </Link>

          {video.channel && (
            <Link
              to="/channel/$channelId"
              params={{ channelId: video.channel.id }}
              className="text-xs text-gray-400 hover:text-white"
            >
              {video.channel.name}
            </Link>
          )}

          <p className="text-xs text-gray-400">
            {formatViewCount(video.viewCount)} - {timeAgo(video.publishedAt)}
          </p>
        </div>
      </div>
    </div>
  );
}
