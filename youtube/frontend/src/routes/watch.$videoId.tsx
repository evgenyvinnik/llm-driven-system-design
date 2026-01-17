import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useVideoStore } from '../stores/videoStore';
import { useAuthStore } from '../stores/authStore';
import { StreamingInfo, Channel } from '../types';
import { api } from '../services/api';
import VideoPlayer from '../components/VideoPlayer';
import VideoCard from '../components/VideoCard';
import CommentSection from '../components/CommentSection';
import { formatViewCount, formatSubscriberCount, timeAgo, getAvatarUrl } from '../utils/format';

export const Route = createFileRoute('/watch/$videoId')({
  component: WatchPage,
});

function WatchPage() {
  const { videoId } = Route.useParams();
  const { user } = useAuthStore();
  const { currentVideo, recommendations, fetchVideo, fetchRecommendations, reactToVideo, recordView } = useVideoStore();

  const [streamingInfo, setStreamingInfo] = useState<StreamingInfo | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);

  useEffect(() => {
    fetchVideo(videoId);
    fetchStreamingInfo();
    fetchRecommendations();
    recordView(videoId);
  }, [videoId]);

  useEffect(() => {
    if (currentVideo?.channel) {
      fetchChannel(currentVideo.channel.id);
    }
  }, [currentVideo?.channel?.id]);

  const fetchStreamingInfo = async () => {
    try {
      const info = await api.get<StreamingInfo>(`/videos/${videoId}/stream`);
      setStreamingInfo(info);
    } catch (error) {
      console.error('Failed to fetch streaming info:', error);
    }
  };

  const fetchChannel = async (channelId: string) => {
    try {
      const ch = await api.get<Channel>(`/channels/${channelId}`);
      setChannel(ch);
      setIsSubscribed(ch.isSubscribed || false);
    } catch (error) {
      console.error('Failed to fetch channel:', error);
    }
  };

  const handleSubscribe = async () => {
    if (!user || !channel) return;

    try {
      if (isSubscribed) {
        await api.delete(`/channels/${channel.id}/subscribe`);
        setIsSubscribed(false);
      } else {
        await api.post(`/channels/${channel.id}/subscribe`);
        setIsSubscribed(true);
      }
    } catch (error) {
      console.error('Failed to toggle subscription:', error);
    }
  };

  const handleReact = (reaction: 'like' | 'dislike') => {
    if (!user) return;
    reactToVideo(videoId, reaction);
  };

  const handleProgress = async (position: number, duration: number) => {
    if (!user) return;
    try {
      await api.post(`/videos/${videoId}/progress`, { position, duration });
    } catch (error) {
      console.error('Failed to save progress:', error);
    }
  };

  if (!currentVideo) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-2 border-white border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row gap-6 p-6">
      {/* Main content */}
      <div className="flex-1 min-w-0">
        {/* Video player */}
        {streamingInfo ? (
          <VideoPlayer
            streamingInfo={streamingInfo}
            onProgress={handleProgress}
            initialPosition={currentVideo.watchProgress?.position}
          />
        ) : (
          <div className="aspect-video bg-black flex items-center justify-center">
            <div className="animate-spin w-8 h-8 border-2 border-white border-t-transparent rounded-full" />
          </div>
        )}

        {/* Video info */}
        <div className="mt-4">
          <h1 className="text-xl font-medium mb-2">{currentVideo.title}</h1>

          <div className="flex flex-wrap items-center justify-between gap-4">
            {/* Channel info */}
            <div className="flex items-center gap-4">
              {channel && (
                <>
                  <img
                    src={getAvatarUrl(channel.avatarUrl, channel.username)}
                    alt={channel.name}
                    className="w-10 h-10 rounded-full"
                  />
                  <div>
                    <p className="font-medium">{channel.name}</p>
                    <p className="text-xs text-gray-400">
                      {formatSubscriberCount(channel.subscriberCount)}
                    </p>
                  </div>
                  {user && user.id !== channel.id && (
                    <button
                      onClick={handleSubscribe}
                      className={isSubscribed ? 'btn-subscribed' : 'btn-subscribe'}
                    >
                      {isSubscribed ? 'Subscribed' : 'Subscribe'}
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2">
              {/* Like/Dislike */}
              <div className="flex items-center bg-yt-dark-hover rounded-full">
                <button
                  onClick={() => handleReact('like')}
                  className={`flex items-center gap-2 px-4 py-2 rounded-l-full hover:bg-gray-600 ${
                    currentVideo.userReaction === 'like' ? 'text-yt-blue' : ''
                  }`}
                >
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/>
                  </svg>
                  <span>{currentVideo.likeCount}</span>
                </button>
                <div className="w-px h-6 bg-gray-600" />
                <button
                  onClick={() => handleReact('dislike')}
                  className={`flex items-center gap-2 px-4 py-2 rounded-r-full hover:bg-gray-600 ${
                    currentVideo.userReaction === 'dislike' ? 'text-yt-blue' : ''
                  }`}
                >
                  <svg className="w-5 h-5 rotate-180" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/>
                  </svg>
                </button>
              </div>

              {/* Share */}
              <button className="btn-secondary flex items-center gap-2">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M14 9V3L22 12L14 21V14.9C9 14.9 5.5 16.5 3 20C4 15 7 10 14 9Z"/>
                </svg>
                Share
              </button>
            </div>
          </div>

          {/* Description */}
          <div className="mt-4 bg-yt-dark-hover rounded-xl p-3">
            <div className="flex items-center gap-2 text-sm mb-2">
              <span>{formatViewCount(currentVideo.viewCount)}</span>
              <span>-</span>
              <span>{timeAgo(currentVideo.publishedAt)}</span>
            </div>
            <div className={`${isDescriptionExpanded ? '' : 'line-clamp-2'}`}>
              <p className="whitespace-pre-wrap">{currentVideo.description || 'No description'}</p>
            </div>
            {currentVideo.description && currentVideo.description.length > 100 && (
              <button
                onClick={() => setIsDescriptionExpanded(!isDescriptionExpanded)}
                className="text-sm font-medium mt-2"
              >
                {isDescriptionExpanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>

          {/* Comments */}
          <CommentSection videoId={videoId} commentCount={currentVideo.commentCount} />
        </div>
      </div>

      {/* Sidebar - Recommendations */}
      <div className="w-full lg:w-96 flex-shrink-0">
        <h3 className="font-medium mb-4">Up next</h3>
        <div className="space-y-2">
          {recommendations
            .filter((v) => v.id !== videoId)
            .slice(0, 10)
            .map((video) => (
              <VideoCard key={video.id} video={video} layout="list" />
            ))}
        </div>
      </div>
    </div>
  );
}
