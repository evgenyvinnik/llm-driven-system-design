import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { VideoPlayer } from '../components';
import { usePlayerStore } from '../stores/playerStore';
import { useAuthStore } from '../stores/authStore';

function WatchPage() {
  const { contentId } = Route.useParams();
  const navigate = useNavigate();
  const { user, currentProfile } = useAuthStore();
  const { loadContent, reset, isLoading, error } = usePlayerStore();

  useEffect(() => {
    // Check if user is logged in with an active profile
    if (!user) {
      navigate({ to: '/login' });
      return;
    }

    if (!currentProfile) {
      navigate({ to: '/profiles' });
      return;
    }

    // Load content
    loadContent(contentId).catch((err) => {
      console.error('Failed to load content:', err);
    });

    // Cleanup on unmount
    return () => {
      reset();
    };
  }, [contentId, user, currentProfile, loadContent, reset, navigate]);

  if (!user || !currentProfile) {
    return null;
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-white mx-auto mb-4"></div>
          <p className="text-white/60">Loading...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-center">
          <p className="text-apple-red text-lg mb-4">{error}</p>
          <button
            onClick={() => navigate({ to: '/' })}
            className="px-6 py-2 bg-white/20 rounded-lg hover:bg-white/30 transition-colors"
          >
            Go Home
          </button>
        </div>
      </div>
    );
  }

  return <VideoPlayer />;
}

export const Route = createFileRoute('/watch/$contentId')({
  component: WatchPage,
});
