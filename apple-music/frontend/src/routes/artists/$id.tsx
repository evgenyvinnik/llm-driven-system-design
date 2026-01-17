import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Play, Plus, Check, Shuffle } from 'lucide-react';
import { catalogApi, libraryApi, radioApi } from '../../services/api';
import { Artist, Album, Track } from '../../types';
import { AlbumCard, TrackRow } from '../../components/MusicCards';
import { usePlayerStore } from '../../stores/playerStore';
import { useAuthStore } from '../../stores/authStore';

export const Route = createFileRoute('/artists/$id')({
  component: ArtistPage,
});

function ArtistPage() {
  const { id } = Route.useParams();
  const { playQueue } = usePlayerStore();
  const { user } = useAuthStore();
  const [artist, setArtist] = useState<Artist & { albums: Album[]; topTracks: Track[] } | null>(null);
  const [isInLibrary, setIsInLibrary] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchArtist = async () => {
      try {
        const data = await catalogApi.getArtist(id);
        setArtist(data);

        if (user) {
          const { inLibrary } = await libraryApi.checkInLibrary('artist', id);
          setIsInLibrary(inLibrary);
        }
      } catch (error) {
        console.error('Failed to fetch artist:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchArtist();
  }, [id, user]);

  const handlePlayTopTracks = () => {
    if (artist?.topTracks && artist.topTracks.length > 0) {
      playQueue(artist.topTracks);
    }
  };

  const handleShuffleAll = () => {
    if (artist?.topTracks && artist.topTracks.length > 0) {
      const shuffled = [...artist.topTracks].sort(() => Math.random() - 0.5);
      playQueue(shuffled);
    }
  };

  const handleToggleLibrary = async () => {
    if (!user || !artist) return;

    try {
      if (isInLibrary) {
        await libraryApi.removeFromLibrary('artist', artist.id);
        setIsInLibrary(false);
      } else {
        await libraryApi.addToLibrary('artist', artist.id);
        setIsInLibrary(true);
      }
    } catch (error) {
      console.error('Failed to update library:', error);
    }
  };

  const handleCreateRadio = async () => {
    if (!user || !artist) return;

    try {
      await radioApi.createPersonalStation('artist', artist.id);
      // Could navigate to radio page or show notification
    } catch (error) {
      console.error('Failed to create radio:', error);
    }
  };

  if (isLoading) {
    return (
      <div className="p-8 flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-2 border-apple-red border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!artist) {
    return (
      <div className="p-8 text-center">
        <p className="text-xl">Artist not found</p>
      </div>
    );
  }

  return (
    <div>
      {/* Hero Header */}
      <div className="relative h-80 bg-gradient-to-b from-apple-red/30 to-apple-bg">
        <div className="absolute inset-0 flex items-end">
          <div className="p-8 flex items-end gap-6">
            <div className="w-48 h-48 rounded-full overflow-hidden shadow-2xl flex-shrink-0">
              {artist.image_url ? (
                <img src={artist.image_url} alt={artist.name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full artwork-placeholder" />
              )}
            </div>
            <div className="pb-4">
              {artist.verified && (
                <span className="inline-flex items-center gap-1 text-sm text-blue-400 mb-2">
                  <Check className="w-4 h-4" />
                  Verified Artist
                </span>
              )}
              <h1 className="text-5xl font-bold mb-2">{artist.name}</h1>
              {artist.genres && artist.genres.length > 0 && (
                <p className="text-apple-text-secondary">
                  {artist.genres.join(', ')}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="p-8">
        {/* Actions */}
        <div className="flex items-center gap-4 mb-10">
          <button
            onClick={handlePlayTopTracks}
            className="flex items-center gap-2 px-6 py-3 bg-apple-red hover:bg-apple-red/80 rounded-full font-medium transition"
          >
            <Play className="w-5 h-5" />
            Play
          </button>

          <button
            onClick={handleShuffleAll}
            className="flex items-center gap-2 px-6 py-3 bg-apple-card hover:bg-white/10 border border-apple-border rounded-full font-medium transition"
          >
            <Shuffle className="w-5 h-5" />
            Shuffle
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
                  Following
                </>
              ) : (
                <>
                  <Plus className="w-5 h-5" />
                  Follow
                </>
              )}
            </button>
          )}
        </div>

        {/* Top Tracks */}
        {artist.topTracks && artist.topTracks.length > 0 && (
          <div className="mb-10">
            <h2 className="text-xl font-semibold mb-4">Top Songs</h2>
            <div className="bg-apple-card rounded-xl overflow-hidden">
              {artist.topTracks.map((track, index) => (
                <TrackRow
                  key={track.id}
                  track={{ ...track, artist_name: artist.name }}
                  index={index}
                  tracks={artist.topTracks}
                  showArtwork
                />
              ))}
            </div>
          </div>
        )}

        {/* Albums */}
        {artist.albums && artist.albums.length > 0 && (
          <div className="mb-10">
            <h2 className="text-xl font-semibold mb-4">Albums</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-6">
              {artist.albums.map((album) => (
                <AlbumCard key={album.id} album={{ ...album, artist_name: artist.name }} />
              ))}
            </div>
          </div>
        )}

        {/* Bio */}
        {artist.bio && (
          <div className="mb-10">
            <h2 className="text-xl font-semibold mb-4">About</h2>
            <p className="text-apple-text-secondary max-w-3xl leading-relaxed">
              {artist.bio}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
