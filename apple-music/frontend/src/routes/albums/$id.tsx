import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Play, Plus, Check, Clock, Calendar } from 'lucide-react';
import { catalogApi, libraryApi } from '../../services/api';
import { Album, Track } from '../../types';
import { TrackRow } from '../../components/MusicCards';
import { usePlayerStore } from '../../stores/playerStore';
import { useAuthStore } from '../../stores/authStore';

export const Route = createFileRoute('/albums/$id')({
  component: AlbumPage,
});

function AlbumPage() {
  const { id } = Route.useParams();
  const { playQueue } = usePlayerStore();
  const { user } = useAuthStore();
  const [album, setAlbum] = useState<Album | null>(null);
  const [isInLibrary, setIsInLibrary] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchAlbum = async () => {
      try {
        const data = await catalogApi.getAlbum(id);
        setAlbum(data);

        if (user) {
          const { inLibrary } = await libraryApi.checkInLibrary('album', id);
          setIsInLibrary(inLibrary);
        }
      } catch (error) {
        console.error('Failed to fetch album:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchAlbum();
  }, [id, user]);

  const handlePlayAll = () => {
    if (album?.tracks && album.tracks.length > 0) {
      playQueue(album.tracks);
    }
  };

  const handleToggleLibrary = async () => {
    if (!user || !album) return;

    try {
      if (isInLibrary) {
        await libraryApi.removeFromLibrary('album', album.id);
        setIsInLibrary(false);
      } else {
        await libraryApi.addToLibrary('album', album.id);
        setIsInLibrary(true);
      }
    } catch (error) {
      console.error('Failed to update library:', error);
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

  if (!album) {
    return (
      <div className="p-8 text-center">
        <p className="text-xl">Album not found</p>
      </div>
    );
  }

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row gap-8 mb-8">
        {/* Artwork */}
        <div className="w-64 h-64 rounded-xl overflow-hidden flex-shrink-0 shadow-2xl">
          {album.artwork_url ? (
            <img src={album.artwork_url} alt={album.title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full artwork-placeholder" />
          )}
        </div>

        {/* Info */}
        <div className="flex flex-col justify-end">
          <p className="text-sm text-apple-text-secondary uppercase tracking-wider mb-2">
            {album.album_type}
          </p>
          <h1 className="text-4xl font-bold mb-2">{album.title}</h1>
          <Link
            to="/artists/$id"
            params={{ id: album.artist_id }}
            className="text-xl text-apple-red hover:underline mb-4"
          >
            {album.artist_name}
          </Link>

          <div className="flex items-center gap-4 text-sm text-apple-text-secondary mb-6">
            {album.release_date && (
              <span className="flex items-center gap-1">
                <Calendar className="w-4 h-4" />
                {new Date(album.release_date).getFullYear()}
              </span>
            )}
            <span>{album.total_tracks} songs</span>
            <span className="flex items-center gap-1">
              <Clock className="w-4 h-4" />
              {formatDuration(album.duration_ms)}
            </span>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-4">
            <button
              onClick={handlePlayAll}
              className="flex items-center gap-2 px-6 py-3 bg-apple-red hover:bg-apple-red/80 rounded-full font-medium transition"
            >
              <Play className="w-5 h-5" />
              Play
            </button>

            {user && (
              <button
                onClick={handleToggleLibrary}
                className={`flex items-center gap-2 px-6 py-3 rounded-full font-medium transition ${
                  isInLibrary
                    ? 'bg-green-600 hover:bg-green-700'
                    : 'bg-apple-card hover:bg-white/10 border border-apple-border'
                }`}
              >
                {isInLibrary ? (
                  <>
                    <Check className="w-5 h-5" />
                    In Library
                  </>
                ) : (
                  <>
                    <Plus className="w-5 h-5" />
                    Add to Library
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Tracks */}
      {album.tracks && album.tracks.length > 0 && (
        <div className="bg-apple-card rounded-xl overflow-hidden">
          {album.tracks.map((track, index) => (
            <TrackRow
              key={track.id}
              track={{ ...track, artwork_url: album.artwork_url }}
              index={index}
              tracks={album.tracks}
              showAlbum={false}
              showArtwork={false}
            />
          ))}
        </div>
      )}
    </div>
  );
}
