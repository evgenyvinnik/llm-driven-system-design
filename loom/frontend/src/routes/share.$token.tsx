import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { sharesApi, ApiError } from '../services/api';
import type { SharedVideo } from '../types';
import { VideoPlayer } from '../components/VideoPlayer';
import { CommentSection } from '../components/CommentSection';
import { useViewTracker } from '../hooks/useViewTracker';

function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return 'This link does not exist or was revoked.';
    if (err.status === 410) return 'This link has expired.';
    if (err.status === 429) return 'Too many attempts. Try again in a few minutes.';
  }
  return err instanceof Error ? err.message : 'Failed to load video';
}

function SharePage() {
  const { token } = Route.useParams();
  const [video, setVideo] = useState<SharedVideo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [playerTime, setPlayerTime] = useState(0);
  const [seekRequest, setSeekRequest] = useState<{ time: number; nonce: number } | null>(null);
  const tracker = useViewTracker(video?.id ?? null, Boolean(video));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    sharesApi
      .open(token)
      .then(({ video: shared }) => {
        if (!cancelled) setVideo(shared);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401 && err.body.requiresPassword) {
          setRequiresPassword(true);
        } else {
          setError(messageFor(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setUnlocking(true);
    setPasswordError(null);
    try {
      // The password goes in the request body, never the URL, so it stays out of logs.
      const { video: shared } = await sharesApi.unlock(token, password);
      setVideo(shared);
      setRequiresPassword(false);
    } catch (err) {
      setPasswordError(
        err instanceof ApiError && err.status === 401 ? 'Incorrect password' : messageFor(err),
      );
    }
    setUnlocking(false);
  };

  const handleTimeUpdate = (time: number, duration: number) => {
    setPlayerTime(time);
    tracker.onTimeUpdate(time, duration);
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
            {passwordError && (
              <div className="bg-red-50 text-red-600 px-4 py-2 rounded-lg text-sm" role="alert">
                {passwordError}
              </div>
            )}
            <label htmlFor="share-password" className="sr-only">
              Password
            </label>
            <input
              id="share-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-loom-border rounded-lg focus:outline-none focus:ring-2 focus:ring-loom-primary"
              placeholder="Enter password"
              autoFocus
            />
            <button
              type="submit"
              disabled={unlocking || password.length === 0}
              className="w-full py-2 bg-loom-primary text-white rounded-lg hover:bg-loom-hover font-medium disabled:opacity-50"
            >
              {unlocking ? 'Checking...' : 'View Video'}
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
    <div className="max-w-6xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2">
        <VideoPlayer
          videoUrl={video.downloadUrl}
          posterUrl={video.thumbnailUrl}
          status={video.status}
          onPlay={tracker.onPlay}
          onEnded={tracker.onEnded}
          onTimeUpdate={handleTimeUpdate}
          seekRequest={seekRequest}
        />

        <div className="mt-4">
          <h1 className="text-xl font-bold text-loom-text">{video.title}</h1>
          {video.description && <p className="text-loom-secondary mt-2">{video.description}</p>}
          <div className="flex items-center gap-4 mt-3 text-sm text-loom-secondary">
            {video.author && <span>by {video.author.displayName || video.author.username}</span>}
            <span>
              {video.viewCount} view{video.viewCount !== 1 ? 's' : ''}
            </span>
            <span>{new Date(video.createdAt).toLocaleDateString()}</span>
          </div>
        </div>
      </div>

      <div className="lg:col-span-1 bg-white rounded-lg border border-loom-border p-4 self-start">
        <h2 className="text-sm font-medium text-loom-text mb-3">Comments</h2>
        <CommentSection
          videoId={video.id}
          playerTime={playerTime}
          onSeek={(time) => setSeekRequest({ time, nonce: Date.now() })}
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute('/share/$token')({
  component: SharePage,
});
