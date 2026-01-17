import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Play, Shuffle, MoreHorizontal, Trash2, Edit2, Clock } from 'lucide-react';
import { playlistApi } from '../../services/api';
import { Playlist, Track } from '../../types';
import { TrackRow } from '../../components/MusicCards';
import { usePlayerStore } from '../../stores/playerStore';
import { useAuthStore } from '../../stores/authStore';

export const Route = createFileRoute('/playlists/$id')({
  component: PlaylistPage,
});

function PlaylistPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { playQueue } = usePlayerStore();
  const { user } = useAuthStore();
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showMenu, setShowMenu] = useState(false);

  const isOwner = user && playlist && user.id === playlist.user_id;

  useEffect(() => {
    const fetchPlaylist = async () => {
      try {
        const data = await playlistApi.getPlaylist(id);
        setPlaylist(data);
      } catch (error) {
        console.error('Failed to fetch playlist:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchPlaylist();
  }, [id]);

  const handlePlayAll = () => {
    if (playlist?.tracks && playlist.tracks.length > 0) {
      playQueue(playlist.tracks);
    }
  };

  const handleShufflePlay = () => {
    if (playlist?.tracks && playlist.tracks.length > 0) {
      const shuffled = [...playlist.tracks].sort(() => Math.random() - 0.5);
      playQueue(shuffled);
    }
  };

  const handleDelete = async () => {
    if (!playlist || !confirm('Are you sure you want to delete this playlist?')) return;

    try {
      await playlistApi.deletePlaylist(playlist.id);
      navigate({ to: '/library' });
    } catch (error) {
      console.error('Failed to delete playlist:', error);
    }
  };

  const handleRemoveTrack = async (trackId: string) => {
    if (!playlist) return;

    try {
      await playlistApi.removeTrack(playlist.id, trackId);
      setPlaylist({
        ...playlist,
        tracks: playlist.tracks?.filter((t) => t.id !== trackId),
        total_tracks: playlist.total_tracks - 1,
      });
    } catch (error) {
      console.error('Failed to remove track:', error);
    }
  };

  const formatDuration = (ms: number) => {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    if (hours > 0) {
      return `${hours} hr ${minutes} min`;
    }
    return `${minutes} min`;
  };

  if (isLoading) {
    return (
      <div className="p-8 flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-2 border-apple-red border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!playlist) {
    return (
      <div className="p-8 text-center">
        <p className="text-xl">Playlist not found</p>
      </div>
    );
  }

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row gap-8 mb-8">
        {/* Artwork */}
        <div className="w-64 h-64 rounded-xl overflow-hidden flex-shrink-0 shadow-2xl">
          {playlist.artwork_url ? (
            <img src={playlist.artwork_url} alt={playlist.name} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full artwork-placeholder flex items-center justify-center">
              <span className="text-6xl font-bold text-white/50">{playlist.name[0]}</span>
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex flex-col justify-end">
          <p className="text-sm text-apple-text-secondary uppercase tracking-wider mb-2">
            Playlist
          </p>
          <h1 className="text-4xl font-bold mb-2">{playlist.name}</h1>
          {playlist.description && (
            <p className="text-apple-text-secondary mb-2">{playlist.description}</p>
          )}
          <p className="text-sm text-apple-text-secondary mb-4">
            Created by {playlist.owner_name || playlist.owner_username}
          </p>

          <div className="flex items-center gap-4 text-sm text-apple-text-secondary mb-6">
            <span>{playlist.total_tracks} songs</span>
            <span className="flex items-center gap-1">
              <Clock className="w-4 h-4" />
              {formatDuration(playlist.duration_ms)}
            </span>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-4">
            <button
              onClick={handlePlayAll}
              disabled={!playlist.tracks || playlist.tracks.length === 0}
              className="flex items-center gap-2 px-6 py-3 bg-apple-red hover:bg-apple-red/80 rounded-full font-medium transition disabled:opacity-50"
            >
              <Play className="w-5 h-5" />
              Play
            </button>

            <button
              onClick={handleShufflePlay}
              disabled={!playlist.tracks || playlist.tracks.length === 0}
              className="flex items-center gap-2 px-6 py-3 bg-apple-card hover:bg-white/10 border border-apple-border rounded-full font-medium transition disabled:opacity-50"
            >
              <Shuffle className="w-5 h-5" />
              Shuffle
            </button>

            {isOwner && (
              <div className="relative">
                <button
                  onClick={() => setShowMenu(!showMenu)}
                  className="p-3 rounded-full hover:bg-white/10 transition"
                >
                  <MoreHorizontal className="w-5 h-5" />
                </button>

                {showMenu && (
                  <div className="absolute left-0 top-full mt-2 w-48 bg-apple-card border border-apple-border rounded-lg shadow-xl z-10">
                    <Link
                      to="/playlists/$id/edit"
                      params={{ id: playlist.id }}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition"
                      onClick={() => setShowMenu(false)}
                    >
                      <Edit2 className="w-4 h-4" />
                      Edit Playlist
                    </Link>
                    <button
                      onClick={handleDelete}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition text-red-400"
                    >
                      <Trash2 className="w-4 h-4" />
                      Delete Playlist
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tracks */}
      {playlist.tracks && playlist.tracks.length > 0 ? (
        <div className="bg-apple-card rounded-xl overflow-hidden">
          {playlist.tracks.map((track, index) => (
            <div key={track.id} className="group relative">
              <TrackRow
                track={track}
                index={index}
                tracks={playlist.tracks}
              />
              {isOwner && (
                <button
                  onClick={() => handleRemoveTrack(track.id)}
                  className="absolute right-16 top-1/2 -translate-y-1/2 p-2 rounded-full hover:bg-white/10 opacity-0 group-hover:opacity-100 transition"
                >
                  <Trash2 className="w-4 h-4 text-red-400" />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-16 bg-apple-card rounded-xl">
          <p className="text-xl font-medium mb-2">This playlist is empty</p>
          <p className="text-apple-text-secondary">
            Add songs to get started.
          </p>
        </div>
      )}
    </div>
  );
}
