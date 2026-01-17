import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { catalogApi, recommendationsApi } from '../services/api';
import { Album, Artist, Track, BrowseSection } from '../types';
import { AlbumCard, ArtistCard, TrackRow } from '../components/MusicCards';

export const Route = createFileRoute('/browse')({
  component: Browse,
});

function Browse() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{
    tracks: Track[];
    albums: Album[];
    artists: Artist[];
  } | null>(null);
  const [browseSections, setBrowseSections] = useState<BrowseSection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    const fetchBrowse = async () => {
      try {
        const { sections } = await recommendationsApi.getBrowse();
        setBrowseSections(sections);
      } catch (error) {
        console.error('Failed to fetch browse data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchBrowse();
  }, []);

  useEffect(() => {
    const searchTimeout = setTimeout(async () => {
      if (searchQuery.trim().length > 1) {
        setIsSearching(true);
        try {
          const results = await catalogApi.search(searchQuery);
          setSearchResults(results);
        } catch (error) {
          console.error('Search failed:', error);
        } finally {
          setIsSearching(false);
        }
      } else {
        setSearchResults(null);
      }
    }, 300);

    return () => clearTimeout(searchTimeout);
  }, [searchQuery]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
  };

  if (isLoading) {
    return (
      <div className="p-8 flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-2 border-apple-red border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Browse</h1>

      {/* Search Bar */}
      <form onSubmit={handleSearch} className="mb-8">
        <div className="relative max-w-xl">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-apple-text-secondary" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search for songs, albums, artists..."
            className="w-full pl-12 pr-4 py-3 bg-apple-card border border-apple-border rounded-xl focus:outline-none focus:border-apple-red transition"
          />
        </div>
      </form>

      {/* Search Results */}
      {searchQuery.trim().length > 1 && (
        <div className="mb-8">
          {isSearching ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin w-6 h-6 border-2 border-apple-red border-t-transparent rounded-full" />
            </div>
          ) : searchResults ? (
            <div className="space-y-8">
              {searchResults.artists.length > 0 && (
                <div>
                  <h2 className="text-xl font-semibold mb-4">Artists</h2>
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6">
                    {searchResults.artists.slice(0, 6).map((artist) => (
                      <ArtistCard key={artist.id} artist={artist} />
                    ))}
                  </div>
                </div>
              )}

              {searchResults.albums.length > 0 && (
                <div>
                  <h2 className="text-xl font-semibold mb-4">Albums</h2>
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6">
                    {searchResults.albums.slice(0, 6).map((album) => (
                      <AlbumCard key={album.id} album={album} />
                    ))}
                  </div>
                </div>
              )}

              {searchResults.tracks.length > 0 && (
                <div>
                  <h2 className="text-xl font-semibold mb-4">Songs</h2>
                  <div className="bg-apple-card rounded-xl overflow-hidden">
                    {searchResults.tracks.slice(0, 10).map((track, index) => (
                      <TrackRow
                        key={track.id}
                        track={track}
                        index={index}
                        tracks={searchResults.tracks}
                      />
                    ))}
                  </div>
                </div>
              )}

              {searchResults.tracks.length === 0 &&
                searchResults.albums.length === 0 &&
                searchResults.artists.length === 0 && (
                  <div className="text-center py-8 text-apple-text-secondary">
                    No results found for "{searchQuery}"
                  </div>
                )}
            </div>
          ) : null}
        </div>
      )}

      {/* Browse Sections */}
      {!searchQuery.trim() && (
        <div className="space-y-10">
          {browseSections.map((section) => (
            <div key={section.id}>
              <h2 className="text-xl font-semibold mb-4">{section.title}</h2>

              {section.type === 'albums' && (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-6">
                  {(section.items as Album[]).map((album) => (
                    <AlbumCard key={album.id} album={album} />
                  ))}
                </div>
              )}

              {section.type === 'artists' && (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-6">
                  {(section.items as Artist[]).map((artist) => (
                    <ArtistCard key={artist.id} artist={artist} />
                  ))}
                </div>
              )}

              {section.type === 'tracks' && (
                <div className="bg-apple-card rounded-xl overflow-hidden">
                  {(section.items as Track[]).slice(0, 10).map((track, index) => (
                    <TrackRow
                      key={track.id}
                      track={track}
                      index={index}
                      tracks={section.items as Track[]}
                    />
                  ))}
                </div>
              )}

              {section.type === 'genres' && (
                <div className="flex flex-wrap gap-3">
                  {(section.items as { genre: string; track_count: number }[]).map(
                    (item) => (
                      <button
                        key={item.genre}
                        onClick={() =>
                          navigate({ to: '/browse', search: { genre: item.genre } })
                        }
                        className="px-4 py-2 bg-apple-card border border-apple-border rounded-full hover:bg-white/10 transition"
                      >
                        {item.genre}
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
