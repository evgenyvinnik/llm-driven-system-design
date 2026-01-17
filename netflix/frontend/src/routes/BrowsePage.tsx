import React from 'react';
import { Navbar, HeroBanner, VideoRow, ContinueWatchingRow } from '../components';
import { useBrowseStore } from '../stores/browseStore';
import { useAuthStore } from '../stores/authStore';
import { useNavigate } from '@tanstack/react-router';

export function BrowsePage() {
  const navigate = useNavigate();
  const { currentProfile, isAuthenticated } = useAuthStore();
  const { homepageRows, continueWatching, isLoading, loadHomepage } = useBrowseStore();

  React.useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }
    if (!currentProfile) {
      navigate({ to: '/profiles' });
      return;
    }
  }, [isAuthenticated, currentProfile, navigate]);

  React.useEffect(() => {
    if (currentProfile) {
      loadHomepage();
    }
  }, [currentProfile, loadHomepage]);

  // Get the first trending video for the hero banner
  const heroVideo = homepageRows.find((r) => r.rowType === 'trending')?.items[0];

  // Separate continue watching from other rows
  const continueWatchingRow = homepageRows.find((r) => r.rowType === 'continue_watching');
  const otherRows = homepageRows.filter((r) => r.rowType !== 'continue_watching');

  if (isLoading && homepageRows.length === 0) {
    return (
      <div className="min-h-screen bg-netflix-black flex items-center justify-center">
        <div className="w-16 h-16 border-4 border-netflix-red border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-netflix-black">
      <Navbar />

      {/* Hero Banner */}
      {heroVideo && <HeroBanner video={heroVideo} />}

      {/* Content rows */}
      <div className="-mt-32 relative z-10">
        {/* Continue Watching */}
        {continueWatching.length > 0 && (
          <ContinueWatchingRow items={continueWatching} />
        )}

        {/* Other rows */}
        {otherRows.map((row, index) => (
          <VideoRow key={`${row.rowType}-${index}`} title={row.title} videos={row.items} />
        ))}
      </div>
    </div>
  );
}
