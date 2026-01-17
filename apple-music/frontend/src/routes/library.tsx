import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { libraryApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { Album, Artist, Track, LibraryCounts } from '../types';
import { AlbumCard, ArtistCard, TrackRow } from '../components/MusicCards';

export const Route = createFileRoute('/library')({
  component: Library,
});

type TabType = 'all' | 'tracks' | 'albums' | 'artists';

function Library() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [activeTab, setActiveTab] = useState<TabType>('all');
  const [tracks, setTracks] = useState<Track[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [artists, setArtists] = useState<Artist[]>([]);
  const [counts, setCounts] = useState<LibraryCounts>({ tracks: 0, albums: 0, artists: 0 });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      navigate({ to: '/login' });
      return;
    }

    const fetchLibrary = async () => {
      setIsLoading(true);
      try {
        if (activeTab === 'all') {
          const data = await libraryApi.getLibrary();
          setTracks(data.tracks || []);
          setAlbums(data.albums || []);
          setArtists(data.artists || []);
          setCounts(data.counts || { tracks: 0, albums: 0, artists: 0 });
        } else {
          const data = await libraryApi.getLibrary(activeTab);
          if (activeTab === 'tracks') {
            setTracks(data.items as Track[] || []);
          } else if (activeTab === 'albums') {
            setAlbums(data.items as Album[] || []);
          } else if (activeTab === 'artists') {
            setArtists(data.items as Artist[] || []);
          }
        }
      } catch (error) {
        console.error('Failed to fetch library:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchLibrary();
  }, [user, activeTab, navigate]);

  if (!user) {
    return null;
  }

  const tabs: { id: TabType; label: string; count?: number }[] = [
    { id: 'all', label: 'All' },
    { id: 'tracks', label: 'Songs', count: counts.tracks },
    { id: 'albums', label: 'Albums', count: counts.albums },
    { id: 'artists', label: 'Artists', count: counts.artists },
  ];

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Library</h1>

      {/* Tabs */}
      <div className="flex gap-2 mb-8 overflow-x-auto pb-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 rounded-full font-medium transition whitespace-nowrap ${
              activeTab === tab.id
                ? 'bg-apple-red text-white'
                : 'bg-apple-card text-apple-text-secondary hover:text-white'
            }`}
          >
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className="ml-2 text-sm opacity-70">({tab.count})</span>
            )}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin w-8 h-8 border-2 border-apple-red border-t-transparent rounded-full" />
        </div>
      ) : (
        <div className="space-y-10">
          {/* Tracks */}
          {(activeTab === 'all' || activeTab === 'tracks') && tracks.length > 0 && (
            <div>
              {activeTab === 'all' && (
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold">Songs</h2>
                  <button
                    onClick={() => setActiveTab('tracks')}
                    className="text-apple-red text-sm hover:underline"
                  >
                    See All
                  </button>
                </div>
              )}
              <div className="bg-apple-card rounded-xl overflow-hidden">
                {tracks.slice(0, activeTab === 'all' ? 5 : undefined).map((track, index) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    index={index}
                    tracks={tracks}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Albums */}
          {(activeTab === 'all' || activeTab === 'albums') && albums.length > 0 && (
            <div>
              {activeTab === 'all' && (
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold">Albums</h2>
                  <button
                    onClick={() => setActiveTab('albums')}
                    className="text-apple-red text-sm hover:underline"
                  >
                    See All
                  </button>
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-6">
                {albums.slice(0, activeTab === 'all' ? 6 : undefined).map((album) => (
                  <AlbumCard key={album.id} album={album} />
                ))}
              </div>
            </div>
          )}

          {/* Artists */}
          {(activeTab === 'all' || activeTab === 'artists') && artists.length > 0 && (
            <div>
              {activeTab === 'all' && (
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold">Artists</h2>
                  <button
                    onClick={() => setActiveTab('artists')}
                    className="text-apple-red text-sm hover:underline"
                  >
                    See All
                  </button>
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-6">
                {artists.slice(0, activeTab === 'all' ? 6 : undefined).map((artist) => (
                  <ArtistCard key={artist.id} artist={artist} />
                ))}
              </div>
            </div>
          )}

          {/* Empty State */}
          {tracks.length === 0 && albums.length === 0 && artists.length === 0 && (
            <div className="text-center py-16">
              <p className="text-xl font-medium mb-2">Your library is empty</p>
              <p className="text-apple-text-secondary">
                Start adding songs, albums, and artists to build your collection.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
