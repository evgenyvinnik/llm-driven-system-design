import { Play, Plus, MoreHorizontal } from 'lucide-react';
import { Track, Album, Artist } from '../types';
import { usePlayerStore } from '../stores/playerStore';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { libraryApi, playlistApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';

interface TrackRowProps {
  track: Track;
  index: number;
  tracks?: Track[];
  showAlbum?: boolean;
  showArtwork?: boolean;
}

export function TrackRow({ track, index, tracks, showAlbum = true, showArtwork = true }: TrackRowProps) {
  const { playTrack, currentTrack, isPlaying } = usePlayerStore();
  const { user } = useAuthStore();
  const [showMenu, setShowMenu] = useState(false);

  const isCurrentTrack = currentTrack?.id === track.id;

  const handlePlay = () => {
    playTrack(track, tracks, index);
  };

  const handleAddToLibrary = async () => {
    if (!user) return;
    try {
      await libraryApi.addToLibrary('track', track.id);
      setShowMenu(false);
    } catch (error) {
      console.error('Failed to add to library:', error);
    }
  };

  const formatDuration = (ms: number) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <div
      className={`group flex items-center gap-4 px-4 py-2 rounded-lg hover:bg-white/5 transition cursor-pointer ${
        isCurrentTrack ? 'bg-white/10' : ''
      }`}
      onClick={handlePlay}
    >
      <div className="w-8 text-center">
        <span className={`group-hover:hidden ${isCurrentTrack ? 'text-apple-red' : 'text-apple-text-secondary'}`}>
          {isCurrentTrack && isPlaying ? (
            <span className="inline-block w-4 h-4">
              <span className="flex gap-0.5">
                <span className="w-1 h-3 bg-apple-red animate-pulse" />
                <span className="w-1 h-4 bg-apple-red animate-pulse delay-75" />
                <span className="w-1 h-2 bg-apple-red animate-pulse delay-150" />
              </span>
            </span>
          ) : (
            index + 1
          )}
        </span>
        <Play className="w-4 h-4 hidden group-hover:block mx-auto" />
      </div>

      {showArtwork && (
        <div className="w-10 h-10 rounded bg-apple-border flex-shrink-0 overflow-hidden">
          {track.artwork_url ? (
            <img src={track.artwork_url} alt={track.album_title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full artwork-placeholder" />
          )}
        </div>
      )}

      <div className="flex-1 min-w-0">
        <p className={`font-medium truncate ${isCurrentTrack ? 'text-apple-red' : ''}`}>
          {track.title}
          {track.explicit && (
            <span className="ml-2 px-1 text-xs bg-apple-text-secondary/30 rounded">E</span>
          )}
        </p>
        <p className="text-sm text-apple-text-secondary truncate">
          <Link
            to="/artists/$id"
            params={{ id: track.artist_id }}
            className="hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {track.artist_name}
          </Link>
        </p>
      </div>

      {showAlbum && (
        <div className="flex-1 min-w-0 hidden md:block">
          <Link
            to="/albums/$id"
            params={{ id: track.album_id }}
            className="text-sm text-apple-text-secondary hover:underline truncate"
            onClick={(e) => e.stopPropagation()}
          >
            {track.album_title}
          </Link>
        </div>
      )}

      <div className="text-sm text-apple-text-secondary">
        {formatDuration(track.duration_ms)}
      </div>

      {user && (
        <div className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowMenu(!showMenu);
            }}
            className="p-2 rounded-full hover:bg-white/10 opacity-0 group-hover:opacity-100 transition"
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>

          {showMenu && (
            <div
              className="absolute right-0 top-full mt-1 w-48 bg-apple-card border border-apple-border rounded-lg shadow-xl z-10"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={handleAddToLibrary}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition text-sm"
              >
                <Plus className="w-4 h-4" />
                Add to Library
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface AlbumCardProps {
  album: Album;
}

export function AlbumCard({ album }: AlbumCardProps) {
  const { playQueue } = usePlayerStore();
  const [isHovered, setIsHovered] = useState(false);

  const handlePlay = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (album.tracks && album.tracks.length > 0) {
      playQueue(album.tracks);
    }
  };

  return (
    <Link
      to="/albums/$id"
      params={{ id: album.id }}
      className="group block hover-scale"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="relative aspect-square rounded-lg overflow-hidden mb-3 bg-apple-border">
        {album.artwork_url ? (
          <img src={album.artwork_url} alt={album.title} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full artwork-placeholder" />
        )}
        {isHovered && (
          <button
            onClick={handlePlay}
            className="absolute bottom-2 right-2 w-10 h-10 bg-apple-red rounded-full flex items-center justify-center shadow-lg transform transition hover:scale-110"
          >
            <Play className="w-5 h-5 text-white ml-0.5" />
          </button>
        )}
      </div>
      <h3 className="font-medium truncate">{album.title}</h3>
      <p className="text-sm text-apple-text-secondary truncate">
        {album.artist_name || 'Unknown Artist'}
      </p>
    </Link>
  );
}

interface ArtistCardProps {
  artist: Artist;
}

export function ArtistCard({ artist }: ArtistCardProps) {
  return (
    <Link to="/artists/$id" params={{ id: artist.id }} className="group block text-center hover-scale">
      <div className="aspect-square rounded-full overflow-hidden mb-3 bg-apple-border mx-auto w-full max-w-[180px]">
        {artist.image_url ? (
          <img src={artist.image_url} alt={artist.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full artwork-placeholder" />
        )}
      </div>
      <h3 className="font-medium truncate">{artist.name}</h3>
      <p className="text-sm text-apple-text-secondary">Artist</p>
    </Link>
  );
}

interface PlaylistCardProps {
  playlist: {
    id: string;
    name: string;
    description?: string;
    artwork_url?: string;
    total_tracks: number;
    owner_name?: string;
  };
}

export function PlaylistCard({ playlist }: PlaylistCardProps) {
  return (
    <Link to="/playlists/$id" params={{ id: playlist.id }} className="group block hover-scale">
      <div className="aspect-square rounded-lg overflow-hidden mb-3 bg-apple-border">
        {playlist.artwork_url ? (
          <img src={playlist.artwork_url} alt={playlist.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full artwork-placeholder flex items-center justify-center">
            <span className="text-4xl font-bold text-white/50">{playlist.name[0]}</span>
          </div>
        )}
      </div>
      <h3 className="font-medium truncate">{playlist.name}</h3>
      <p className="text-sm text-apple-text-secondary truncate">
        {playlist.owner_name || `${playlist.total_tracks} tracks`}
      </p>
    </Link>
  );
}

interface RadioStationCardProps {
  station: {
    id: string;
    name: string;
    description?: string;
    artwork_url?: string;
  };
}

export function RadioStationCard({ station }: RadioStationCardProps) {
  return (
    <Link to="/radio/$id" params={{ id: station.id }} className="group block hover-scale">
      <div className="aspect-square rounded-lg overflow-hidden mb-3 bg-gradient-to-br from-apple-red to-apple-pink">
        {station.artwork_url ? (
          <img src={station.artwork_url} alt={station.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-4xl font-bold text-white/80">{station.name[0]}</span>
          </div>
        )}
      </div>
      <h3 className="font-medium truncate">{station.name}</h3>
      {station.description && (
        <p className="text-sm text-apple-text-secondary truncate">{station.description}</p>
      )}
    </Link>
  );
}
