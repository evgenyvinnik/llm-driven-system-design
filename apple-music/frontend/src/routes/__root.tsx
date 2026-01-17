import { createRootRoute, Outlet } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Sidebar } from '../components/Sidebar';
import { Player } from '../components/Player';
import { useAuthStore } from '../stores/authStore';
import { playlistApi } from '../services/api';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const { user, checkAuth, isLoading } = useAuthStore();
  const [playlists, setPlaylists] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (user) {
      playlistApi.getPlaylists().then(({ playlists }) => {
        setPlaylists(playlists);
      }).catch(() => {});
    } else {
      setPlaylists([]);
    }
  }, [user]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-apple-bg flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-apple-red border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-apple-bg flex">
      <Sidebar playlists={playlists} />
      <main className="flex-1 overflow-y-auto pb-24">
        <Outlet />
      </main>
      <Player />
    </div>
  );
}
