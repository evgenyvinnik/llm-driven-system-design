import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { libraryApi } from '../services/api';
import type { Track } from '../types';
import { TrackList } from '../components/TrackList';
import { usePlayerStore } from '../stores/playerStore';
import { useAuthStore } from '../stores/authStore';
import { getTotalDuration } from '../utils/format';

export const Route = createFileRoute('/library/liked')({
  component: LikedSongsPage,
});

function LikedSongsPage() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading: authLoading, user } = useAuthStore();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const { playQueue, currentTrack, isPlaying, togglePlay } = usePlayerStore();

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login' });
    }
  }, [isAuthenticated, authLoading, navigate]);

  useEffect(() => {
    if (!isAuthenticated) return;

    const fetchLikedSongs = async () => {
      try {
        const data = await libraryApi.getLikedSongs({ limit: 100 });
        setTracks(data.tracks);
        setTotal(data.total);
      } catch (error) {
        console.error('Failed to fetch liked songs:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchLikedSongs();
  }, [isAuthenticated]);

  if (authLoading || !isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-spotify-green border-t-transparent"></div>
      </div>
    );
  }

  const isPlayingLiked = currentTrack && tracks.some(t => t.id === currentTrack.id) && isPlaying;

  const handlePlay = () => {
    if (isPlayingLiked) {
      togglePlay();
    } else if (tracks.length > 0) {
      playQueue(tracks, 0);
    }
  };

  const handlePlayTrack = (_track: Track, index: number) => {
    playQueue(tracks, index);
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-end gap-6 mb-8 -mx-6 -mt-6 px-6 pt-12 pb-6 bg-gradient-to-b from-purple-800 to-transparent">
        <div className="w-48 h-48 bg-gradient-to-br from-purple-600 to-blue-400 rounded shadow-2xl flex items-center justify-center">
          <svg className="w-20 h-20 text-white" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-sm text-white font-semibold uppercase">Playlist</p>
          <h1 className="text-5xl font-bold text-white mt-2 mb-6">Liked Songs</h1>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-white font-semibold">{user?.display_name}</span>
            {tracks.length > 0 && (
              <>
                <span className="text-white/70">-</span>
                <span className="text-white/70">{total} songs, {getTotalDuration(tracks)}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Play button */}
      {tracks.length > 0 && (
        <div className="flex items-center gap-6 mb-6">
          <button
            onClick={handlePlay}
            className="w-14 h-14 bg-spotify-green rounded-full flex items-center justify-center hover:scale-105 transition-transform shadow-lg"
          >
            {isPlayingLiked ? (
              <svg className="w-8 h-8 text-black" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            ) : (
              <svg className="w-8 h-8 text-black" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-spotify-green border-t-transparent"></div>
        </div>
      ) : tracks.length > 0 ? (
        <TrackList tracks={tracks} onPlay={handlePlayTrack} />
      ) : (
        <div className="text-center py-16">
          <svg className="w-16 h-16 text-spotify-text mx-auto mb-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
          <h3 className="text-xl font-bold text-white mb-2">Songs you like will appear here</h3>
          <p className="text-spotify-text mb-6">Save songs by tapping the heart icon</p>
          <Link
            to="/search"
            className="px-6 py-3 bg-white text-black font-semibold rounded-full hover:scale-105 transition-transform inline-block"
          >
            Find songs
          </Link>
        </div>
      )}
    </div>
  );
}
