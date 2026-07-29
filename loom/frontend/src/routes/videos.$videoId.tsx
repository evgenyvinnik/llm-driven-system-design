import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useVideoStore } from '../stores/videoStore';
import { useAuthStore } from '../stores/authStore';
import { VideoPlayer } from '../components/VideoPlayer';
import { CommentSection } from '../components/CommentSection';
import { AnalyticsPanel } from '../components/AnalyticsPanel';
import { ShareModal } from '../components/ShareModal';
import { uploadApi } from '../services/api';

function VideoPage() {
  const { videoId } = Route.useParams();
  const currentVideo = useVideoStore((s) => s.currentVideo);
  const loading = useVideoStore((s) => s.loading);
  const fetchVideo = useVideoStore((s) => s.fetchVideo);
  const user = useAuthStore((s) => s.user);

  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [showShareModal, setShowShareModal] = useState(false);
  const [activeTab, setActiveTab] = useState<'comments' | 'analytics'>('comments');
  const [playerTime, setPlayerTime] = useState(0);

  useEffect(() => {
    fetchVideo(videoId);
  }, [videoId, fetchVideo]);

  useEffect(() => {
    if (currentVideo?.status === 'ready') {
      uploadApi.getDownloadUrl(currentVideo.id).then(({ downloadUrl: url }) => {
        setDownloadUrl(url);
      }).catch(() => {
        // Video file may not exist in MinIO
      });
    }
  }, [currentVideo]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-loom-secondary">Loading video...</div>
      </div>
    );
  }

  if (!currentVideo) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-loom-secondary">Video not found</div>
      </div>
    );
  }

  const isOwner = user?.id === currentVideo.userId;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Video Player Column */}
        <div className="lg:col-span-2">
          <VideoPlayer
            videoUrl={downloadUrl}
            posterUrl={currentVideo.thumbnailUrl}
            status={currentVideo.status}
            onTimeUpdate={setPlayerTime}
          />

          <div className="mt-4">
            <h1 className="text-xl font-bold text-loom-text">{currentVideo.title}</h1>
            {currentVideo.description && (
              <p className="text-loom-secondary mt-2">{currentVideo.description}</p>
            )}
            <div className="flex items-center gap-4 mt-3 text-sm text-loom-secondary">
              {currentVideo.author && (
                <span>by {currentVideo.author.displayName || currentVideo.author.username}</span>
              )}
              <span>{currentVideo.viewCount} view{currentVideo.viewCount !== 1 ? 's' : ''}</span>
              <span>{new Date(currentVideo.createdAt).toLocaleDateString()}</span>
              {currentVideo.durationSeconds && (
                <span>{formatDuration(currentVideo.durationSeconds)}</span>
              )}
            </div>

            {isOwner && (
              <div className="flex gap-2 mt-4">
                <button
                  data-testid="share-button"
                  onClick={() => setShowShareModal(true)}
                  className="px-4 py-2 bg-loom-primary text-white rounded-lg hover:bg-loom-hover text-sm font-medium"
                >
                  Share
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Sidebar Column */}
        <div className="lg:col-span-1">
          <div className="bg-white rounded-lg border border-loom-border">
            <div className="flex border-b border-loom-border">
              <button
                onClick={() => setActiveTab('comments')}
                className={`flex-1 py-3 text-sm font-medium text-center ${
                  activeTab === 'comments'
                    ? 'text-loom-primary border-b-2 border-loom-primary'
                    : 'text-loom-secondary hover:text-loom-text'
                }`}
              >
                Comments
              </button>
              {isOwner && (
                <button
                  data-testid="analytics-tab"
                  onClick={() => setActiveTab('analytics')}
                  className={`flex-1 py-3 text-sm font-medium text-center ${
                    activeTab === 'analytics'
                      ? 'text-loom-primary border-b-2 border-loom-primary'
                      : 'text-loom-secondary hover:text-loom-text'
                  }`}
                >
                  Analytics
                </button>
              )}
            </div>

            <div className="p-4">
              {activeTab === 'comments' ? (
                <CommentSection videoId={videoId} playerTime={playerTime} />
              ) : (
                <AnalyticsPanel videoId={videoId} />
              )}
            </div>
          </div>
        </div>
      </div>

      {showShareModal && (
        <ShareModal videoId={videoId} onClose={() => setShowShareModal(false)} />
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export const Route = createFileRoute('/videos/$videoId')({
  component: VideoPage,
});
