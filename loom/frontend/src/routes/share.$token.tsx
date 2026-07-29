import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { sharesApi, analyticsApi } from '../services/api';
import type { Video } from '../types';
import { VideoPlayer } from '../components/VideoPlayer';

function SharePage() {
  const { token } = Route.useParams();
  const [video, setVideo] = useState<(Video & { downloadUrl: string | null; allowDownload: boolean }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [password, setPassword] = useState('');

  const loadShare = async (pwd?: string) => {
    setLoading(true);
    setError(null);
    try {
      const { video: sharedVideo } = await sharesApi.validate(token, pwd);
      setVideo(sharedVideo);
      setRequiresPassword(false);

      // Record anonymous view
      const sessionId = `anon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      analyticsApi.recordView(sharedVideo.id, sessionId).catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load video';
      if (message === 'Password required') {
        setRequiresPassword(true);
      } else {
        setError(message);
      }
    }
    setLoading(false);
  };

  useEffect(() => {
    loadShare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loadShare(password);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-loom-secondary">Loading...</div>
      </div>
    );
  }

  if (requiresPassword) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="bg-white rounded-xl shadow-lg p-8 w-full max-w-md">
          <h2 className="text-xl font-bold text-loom-text mb-4">Password Required</h2>
          <p className="text-loom-secondary mb-6">This video is password protected.</p>
          <form onSubmit={handlePasswordSubmit} className="space-y-4">
            {error && (
              <div className="bg-red-50 text-red-600 px-4 py-2 rounded-lg text-sm">{error}</div>
            )}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-loom-border rounded-lg focus:outline-none focus:ring-2 focus:ring-loom-primary"
              placeholder="Enter password"
              autoFocus
            />
            <button
              type="submit"
              className="w-full py-2 bg-loom-primary text-white rounded-lg hover:bg-loom-hover font-medium"
            >
              View Video
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <h2 className="text-xl font-bold text-loom-text mb-2">Oops!</h2>
          <p className="text-loom-secondary">{error}</p>
        </div>
      </div>
    );
  }

  if (!video) return null;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <VideoPlayer
        videoUrl={video.downloadUrl}
        posterUrl={video.thumbnailUrl}
        status={video.status}
      />

      <div className="mt-4">
        <h1 className="text-xl font-bold text-loom-text">{video.title}</h1>
        {video.description && (
          <p className="text-loom-secondary mt-2">{video.description}</p>
        )}
        <div className="flex items-center gap-4 mt-3 text-sm text-loom-secondary">
          {video.author && (
            <span>by {video.author.displayName || video.author.username}</span>
          )}
          <span>{video.viewCount} view{video.viewCount !== 1 ? 's' : ''}</span>
          <span>{new Date(video.createdAt).toLocaleDateString()}</span>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/share/$token')({
  component: SharePage,
});
