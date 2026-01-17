import { Link } from '@tanstack/react-router';
import { Video } from '@/types';
import { useFeedStore } from '@/stores/feedStore';
import { useAuthStore } from '@/stores/authStore';
import { useState } from 'react';

interface VideoActionsProps {
  video: Video;
}

export default function VideoActions({ video }: VideoActionsProps) {
  const { likeVideo, unlikeVideo } = useFeedStore();
  const { isAuthenticated } = useAuthStore();
  const [showComments, setShowComments] = useState(false);

  const handleLike = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isAuthenticated) return;

    if (video.isLiked) {
      await unlikeVideo(video.id);
    } else {
      await likeVideo(video.id);
    }
  };

  const formatCount = (count: number): string => {
    if (count >= 1000000) {
      return (count / 1000000).toFixed(1) + 'M';
    }
    if (count >= 1000) {
      return (count / 1000).toFixed(1) + 'K';
    }
    return count.toString();
  };

  return (
    <>
      <div className="absolute right-2 bottom-32 flex flex-col items-center gap-4">
        {/* Creator Avatar */}
        <Link
          to="/profile/$username"
          params={{ username: video.creatorUsername }}
          className="relative"
          onClick={(e) => e.stopPropagation()}
        >
          {video.creatorAvatarUrl ? (
            <img
              src={video.creatorAvatarUrl}
              alt={video.creatorDisplayName}
              className="w-12 h-12 rounded-full border-2 border-white"
            />
          ) : (
            <div className="w-12 h-12 rounded-full bg-gray-600 border-2 border-white flex items-center justify-center text-lg">
              {video.creatorDisplayName?.[0]?.toUpperCase() || 'U'}
            </div>
          )}
          <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-5 h-5 bg-tiktok-red rounded-full flex items-center justify-center">
            <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 4v16m8-8H4" />
            </svg>
          </div>
        </Link>

        {/* Like Button */}
        <button
          onClick={handleLike}
          className="flex flex-col items-center"
        >
          <div className={`w-12 h-12 rounded-full bg-gray-800/50 flex items-center justify-center ${video.isLiked ? 'text-tiktok-red' : 'text-white'}`}>
            <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
            </svg>
          </div>
          <span className="text-xs text-white mt-1">{formatCount(video.likeCount)}</span>
        </button>

        {/* Comment Button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowComments(true);
          }}
          className="flex flex-col items-center"
        >
          <div className="w-12 h-12 rounded-full bg-gray-800/50 flex items-center justify-center text-white">
            <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
              <path d="M21.99 4c0-1.1-.89-2-1.99-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4-.01-18z" />
            </svg>
          </div>
          <span className="text-xs text-white mt-1">{formatCount(video.commentCount)}</span>
        </button>

        {/* Share Button */}
        <button
          onClick={(e) => e.stopPropagation()}
          className="flex flex-col items-center"
        >
          <div className="w-12 h-12 rounded-full bg-gray-800/50 flex items-center justify-center text-white">
            <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
              <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z" />
            </svg>
          </div>
          <span className="text-xs text-white mt-1">{formatCount(video.shareCount)}</span>
        </button>
      </div>

      {/* Comments Modal */}
      {showComments && (
        <CommentsModal
          videoId={video.id}
          onClose={() => setShowComments(false)}
        />
      )}
    </>
  );
}

function CommentsModal({ videoId, onClose }: { videoId: number; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative w-full h-2/3 bg-gray-900 rounded-t-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <span className="font-semibold">Comments</span>
          <button onClick={onClose} className="text-gray-400">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 p-4 text-center text-gray-500">
          <p>Comments for video {videoId}</p>
          <p className="text-sm mt-2">Comment feature coming soon!</p>
        </div>
      </div>
    </div>
  );
}
