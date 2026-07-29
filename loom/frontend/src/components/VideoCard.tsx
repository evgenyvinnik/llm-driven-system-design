import { useNavigate } from '@tanstack/react-router';
import type { Video } from '../types';

interface VideoCardProps {
  video: Video;
  onDelete: (id: string) => void;
}

/** Displays a video thumbnail card with title, duration, view count, and delete action. */
export function VideoCard({ video, onDelete }: VideoCardProps) {
  const navigate = useNavigate();

  const handleClick = () => {
    navigate({ to: '/videos/$videoId', params: { videoId: video.id } });
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('Delete this video?')) {
      onDelete(video.id);
    }
  };

  return (
    <div
      onClick={handleClick}
      className="bg-white rounded-lg border border-loom-border overflow-hidden cursor-pointer hover:shadow-md transition-shadow group"
    >
      {/* Thumbnail */}
      <div className="relative aspect-video bg-gray-100">
        {video.status === 'processing' ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-sm text-loom-secondary">Processing...</div>
          </div>
        ) : video.status === 'failed' ? (
          <div className="absolute inset-0 flex items-center justify-center bg-red-50">
            <div className="text-sm text-loom-danger">Failed</div>
          </div>
        ) : video.thumbnailUrl ? (
          <>
            <img
              src={video.thumbnailUrl}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
              loading="lazy"
            />
            {/* Play affordance over the still, so a thumbnail still reads as video. */}
            <div className="absolute inset-0 flex items-center justify-center bg-black/10 opacity-0 group-hover:opacity-100 transition-opacity">
              <svg viewBox="0 0 48 48" fill="none" className="w-12 h-12">
                <circle cx="24" cy="24" r="20" fill="#fff" opacity="0.9" />
                <polygon points="20,16 34,24 20,32" fill="#625DF5" />
              </svg>
            </div>
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-loom-sidebar/5">
            <svg viewBox="0 0 48 48" fill="none" className="w-12 h-12 opacity-30">
              <circle cx="24" cy="24" r="20" fill="#625DF5" opacity="0.2" />
              <polygon points="20,16 34,24 20,32" fill="#625DF5" />
            </svg>
          </div>
        )}

        {/* Duration badge */}
        {video.durationSeconds && (
          <div className="absolute bottom-2 right-2 bg-black/70 text-white text-xs px-1.5 py-0.5 rounded">
            {formatDuration(video.durationSeconds)}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-3">
        <h3 className="text-sm font-medium text-loom-text truncate">{video.title}</h3>
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-2 text-xs text-loom-secondary">
            <span>{video.viewCount} view{video.viewCount !== 1 ? 's' : ''}</span>
            <span>{timeAgo(video.createdAt)}</span>
          </div>
          <button
            onClick={handleDelete}
            className="opacity-0 group-hover:opacity-100 text-loom-secondary hover:text-loom-danger transition-all text-xs"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}
