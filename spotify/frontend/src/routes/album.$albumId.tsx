import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { catalogApi } from '../services/api';
import type { Album, Track } from '../types';
import { TrackList } from '../components/TrackList';
import { usePlayerStore } from '../stores/playerStore';
import { getYearFromDate, getTotalDuration } from '../utils/format';

export const Route = createFileRoute('/album/$albumId')({
  component: AlbumPage,
});

function AlbumPage() {
  const { albumId } = Route.useParams();
  const [album, setAlbum] = useState<Album | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { playQueue, currentTrack, isPlaying, togglePlay } = usePlayerStore();

  useEffect(() => {
    const fetchAlbum = async () => {
      try {
        const data = await catalogApi.getAlbum(albumId);
        setAlbum(data);
      } catch (error) {
        console.error('Failed to fetch album:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchAlbum();
  }, [albumId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-spotify-green border-t-transparent"></div>
      </div>
    );
  }

  if (!album) {
    return (
      <div className="text-center py-16">
        <h2 className="text-2xl font-bold text-white mb-2">Album not found</h2>
        <Link to="/" className="text-spotify-green hover:underline">
          Go back home
        </Link>
      </div>
    );
  }

  const tracks = album.tracks || [];
  const isPlayingAlbum = currentTrack && tracks.some(t => t.id === currentTrack.id) && isPlaying;

  const handlePlayAlbum = () => {
    if (isPlayingAlbum) {
      togglePlay();
    } else if (tracks.length > 0) {
      playQueue(tracks, 0);
    }
  };

  const handlePlayTrack = (track: Track, index: number) => {
    playQueue(tracks, index);
  };

  // Add album info to tracks for display
  const tracksWithAlbum = tracks.map(track => ({
    ...track,
    album_title: album.title,
    album_cover_url: album.cover_url,
    artist_name: album.artist_name,
    artist_id: album.artist_id,
  }));

  return (
    <div>
      {/* Header */}
      <div className="flex items-end gap-6 mb-8 -mx-6 -mt-6 px-6 pt-12 pb-6 bg-gradient-to-b from-spotify-light-gray/50 to-transparent">
        <div className="w-48 h-48 bg-spotify-light-gray rounded shadow-2xl flex-shrink-0 overflow-hidden">
          {album.cover_url ? (
            <img src={album.cover_url} alt={album.title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-spotify-text">
              <svg className="w-16 h-16" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z" />
              </svg>
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-sm text-white font-semibold uppercase">
            {album.album_type === 'single' ? 'Single' : album.album_type === 'ep' ? 'EP' : 'Album'}
          </p>
          <h1 className="text-5xl font-bold text-white mt-2 mb-6 truncate">{album.title}</h1>
          <div className="flex items-center gap-2 text-sm">
            <Link
              to="/artist/$artistId"
              params={{ artistId: album.artist_id }}
              className="text-white font-semibold hover:underline"
            >
              {album.artist_name}
            </Link>
            <span className="text-spotify-text">-</span>
            <span className="text-spotify-text">{album.release_date && getYearFromDate(album.release_date)}</span>
            <span className="text-spotify-text">-</span>
            <span className="text-spotify-text">{tracks.length} songs, {getTotalDuration(tracks)}</span>
          </div>
        </div>
      </div>

      {/* Play button and actions */}
      <div className="flex items-center gap-6 mb-6">
        <button
          onClick={handlePlayAlbum}
          className="w-14 h-14 bg-spotify-green rounded-full flex items-center justify-center hover:scale-105 transition-transform shadow-lg"
        >
          {isPlayingAlbum ? (
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

      {/* Track list */}
      <TrackList
        tracks={tracksWithAlbum}
        showAlbum={false}
        onPlay={handlePlayTrack}
      />
    </div>
  );
}
