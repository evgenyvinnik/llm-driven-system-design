import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { playlistApi } from '../services/api';
import type { Playlist, Track } from '../types';
import { TrackList } from '../components/TrackList';
import { usePlayerStore } from '../stores/playerStore';
import { useAuthStore } from '../stores/authStore';
import { getTotalDuration } from '../utils/format';

export const Route = createFileRoute('/playlist/$playlistId')({
  component: PlaylistPage,
});

function PlaylistPage() {
  const { playlistId } = Route.useParams();
  const { user } = useAuthStore();
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { playQueue, currentTrack, isPlaying, togglePlay } = usePlayerStore();

  useEffect(() => {
    const fetchPlaylist = async () => {
      try {
        const data = await playlistApi.getPlaylist(playlistId);
        setPlaylist(data);
      } catch (error) {
        console.error('Failed to fetch playlist:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchPlaylist();
  }, [playlistId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-spotify-green border-t-transparent"></div>
      </div>
    );
  }

  if (!playlist) {
    return (
      <div className="text-center py-16">
        <h2 className="text-2xl font-bold text-white mb-2">Playlist not found</h2>
        <Link to="/" className="text-spotify-green hover:underline">
          Go back home
        </Link>
      </div>
    );
  }

  const tracks = playlist.tracks || [];
  const isOwner = user?.id === playlist.owner_id;
  const isPlayingPlaylist = currentTrack && tracks.some(t => t.id === currentTrack.id) && isPlaying;

  const handlePlayPlaylist = () => {
    if (isPlayingPlaylist) {
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
      <div className="flex items-end gap-6 mb-8 -mx-6 -mt-6 px-6 pt-12 pb-6 bg-gradient-to-b from-purple-900/50 to-transparent">
        <div className="w-48 h-48 bg-spotify-light-gray rounded shadow-2xl flex-shrink-0 overflow-hidden">
          {playlist.cover_url ? (
            <img src={playlist.cover_url} alt={playlist.name} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-spotify-text bg-gradient-to-br from-purple-800 to-blue-600">
              <svg className="w-16 h-16 text-white/50" fill="currentColor" viewBox="0 0 24 24">
                <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z" />
              </svg>
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-sm text-white font-semibold uppercase">Playlist</p>
          <h1 className="text-5xl font-bold text-white mt-2 mb-6 truncate">{playlist.name}</h1>
          {playlist.description && (
            <p className="text-spotify-text text-sm mb-4">{playlist.description}</p>
          )}
          <div className="flex items-center gap-2 text-sm">
            <span className="text-white font-semibold">{playlist.owner_username}</span>
            {tracks.length > 0 && (
              <>
                <span className="text-spotify-text">-</span>
                <span className="text-spotify-text">{tracks.length} songs, {getTotalDuration(tracks)}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Play button and actions */}
      <div className="flex items-center gap-6 mb-6">
        {tracks.length > 0 && (
          <button
            onClick={handlePlayPlaylist}
            className="w-14 h-14 bg-spotify-green rounded-full flex items-center justify-center hover:scale-105 transition-transform shadow-lg"
          >
            {isPlayingPlaylist ? (
              <svg className="w-8 h-8 text-black" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            ) : (
              <svg className="w-8 h-8 text-black" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
        )}

        {isOwner && (
          <button className="text-spotify-text hover:text-white">
            <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
            </svg>
          </button>
        )}
      </div>

      {/* Track list */}
      {tracks.length > 0 ? (
        <TrackList tracks={tracks} onPlay={handlePlayTrack} />
      ) : (
        <div className="text-center py-16">
          <svg className="w-16 h-16 text-spotify-text mx-auto mb-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z" />
          </svg>
          <h3 className="text-xl font-bold text-white mb-2">This playlist is empty</h3>
          <p className="text-spotify-text">Start adding songs to your playlist</p>
        </div>
      )}
    </div>
  );
}
