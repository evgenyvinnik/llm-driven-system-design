import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect, useCallback } from 'react';
import { catalogApi } from '../services/api';
import type { SearchResults, Track } from '../types';
import { AlbumCard, TrackList } from '../components/TrackList';
import { usePlayerStore } from '../stores/playerStore';

export const Route = createFileRoute('/search')({
  component: SearchPage,
});

function SearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults>({});
  const [isSearching, setIsSearching] = useState(false);
  const { playTrack } = usePlayerStore();

  const performSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      setResults({});
      return;
    }

    setIsSearching(true);
    try {
      const data = await catalogApi.search(searchQuery, { limit: 20 });
      setResults(data);
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setIsSearching(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      performSearch(query);
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [query, performSearch]);

  const hasResults = results.artists?.length || results.albums?.length || results.tracks?.length;

  return (
    <div>
      {/* Search input */}
      <div className="mb-8">
        <div className="relative max-w-xl">
          <svg
            className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-spotify-text"
            fill="currentColor"
            viewBox="0 0 24 24"
          >
            <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="What do you want to listen to?"
            className="w-full pl-12 pr-4 py-3 bg-white text-black rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-white"
            autoFocus
          />
        </div>
      </div>

      {isSearching && (
        <div className="flex items-center justify-center h-32">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-spotify-green border-t-transparent"></div>
        </div>
      )}

      {!isSearching && query && !hasResults && (
        <div className="text-center py-16">
          <h2 className="text-2xl font-bold text-white mb-2">No results found for "{query}"</h2>
          <p className="text-spotify-text">
            Please make sure your words are spelled correctly, or use fewer or different keywords.
          </p>
        </div>
      )}

      {!isSearching && hasResults && (
        <div className="space-y-8">
          {/* Top result and tracks */}
          {results.tracks && results.tracks.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-6">
              {/* Top result */}
              <section>
                <h2 className="text-2xl font-bold text-white mb-4">Top result</h2>
                <button
                  onClick={() => playTrack(results.tracks![0], results.tracks!)}
                  className="w-full p-5 bg-spotify-dark-gray hover:bg-spotify-hover rounded-lg text-left group transition-colors"
                >
                  <div className="w-24 h-24 bg-spotify-light-gray rounded mb-4 overflow-hidden shadow-lg">
                    {results.tracks[0].album_cover_url && (
                      <img
                        src={results.tracks[0].album_cover_url}
                        alt={results.tracks[0].album_title}
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>
                  <h3 className="text-3xl font-bold text-white mb-2">{results.tracks[0].title}</h3>
                  <p className="text-spotify-text text-sm">
                    Song - {results.tracks[0].artist_name}
                  </p>
                  <div className="absolute bottom-5 right-5 w-12 h-12 bg-spotify-green rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all shadow-lg">
                    <svg className="w-6 h-6 text-black" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </div>
                </button>
              </section>

              {/* Songs */}
              <section>
                <h2 className="text-2xl font-bold text-white mb-4">Songs</h2>
                <div className="space-y-1">
                  {results.tracks.slice(0, 4).map((track, index) => (
                    <TrackRow
                      key={track.id}
                      track={track}
                      allTracks={results.tracks!}
                      index={index}
                    />
                  ))}
                </div>
              </section>
            </div>
          )}

          {/* Artists */}
          {results.artists && results.artists.length > 0 && (
            <section>
              <h2 className="text-2xl font-bold text-white mb-4">Artists</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
                {results.artists.slice(0, 6).map((artist) => (
                  <Link
                    key={artist.id}
                    to="/artist/$artistId"
                    params={{ artistId: artist.id }}
                    className="group p-4 bg-spotify-dark-gray rounded-lg hover:bg-spotify-hover transition-colors"
                  >
                    <div className="relative mb-4">
                      <div className="aspect-square bg-spotify-light-gray rounded-full overflow-hidden shadow-lg">
                        {artist.image_url ? (
                          <img src={artist.image_url} alt={artist.name} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-spotify-text">
                            <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                            </svg>
                          </div>
                        )}
                      </div>
                    </div>
                    <p className="font-semibold text-white truncate mb-1">{artist.name}</p>
                    <p className="text-sm text-spotify-text">Artist</p>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {/* Albums */}
          {results.albums && results.albums.length > 0 && (
            <section>
              <h2 className="text-2xl font-bold text-white mb-4">Albums</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
                {results.albums.slice(0, 6).map((album) => (
                  <AlbumCard key={album.id} album={album} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* Browse categories when no search */}
      {!query && (
        <div>
          <h2 className="text-2xl font-bold text-white mb-6">Browse all</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6">
            {browseCategories.map((category) => (
              <div
                key={category.name}
                className="relative aspect-square rounded-lg overflow-hidden cursor-pointer"
                style={{ backgroundColor: category.color }}
              >
                <h3 className="absolute top-4 left-4 text-2xl font-bold text-white">{category.name}</h3>
                <div className="absolute bottom-0 right-0 w-24 h-24 rotate-25 translate-x-4 translate-y-4">
                  <div className="w-full h-full bg-white/10 rounded"></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TrackRow({ track, allTracks }: { track: Track; allTracks: Track[]; index: number }) {
  const { playTrack, currentTrack, isPlaying } = usePlayerStore();
  const isCurrentTrack = currentTrack?.id === track.id;

  return (
    <button
      onClick={() => playTrack(track, allTracks)}
      className="w-full flex items-center gap-3 p-2 rounded hover:bg-spotify-hover group"
    >
      <div className="w-10 h-10 bg-spotify-light-gray rounded flex-shrink-0 overflow-hidden relative">
        {track.album_cover_url && (
          <img src={track.album_cover_url} alt={track.album_title} className="w-full h-full object-cover" />
        )}
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          {isCurrentTrack && isPlaying ? (
            <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            </svg>
          ) : (
            <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </div>
      </div>
      <div className="flex-1 text-left min-w-0">
        <p className={`truncate font-medium ${isCurrentTrack ? 'text-spotify-green' : 'text-white'}`}>
          {track.title}
        </p>
        <p className="text-sm text-spotify-text truncate">{track.artist_name}</p>
      </div>
    </button>
  );
}

const browseCategories = [
  { name: 'Pop', color: '#8D67AB' },
  { name: 'Hip-Hop', color: '#BA5D07' },
  { name: 'Rock', color: '#E61E32' },
  { name: 'Electronic', color: '#1E3264' },
  { name: 'Jazz', color: '#608108' },
  { name: 'R&B', color: '#477D95' },
  { name: 'Classical', color: '#8C1932' },
  { name: 'Country', color: '#A56752' },
  { name: 'Indie', color: '#509BF5' },
  { name: 'Metal', color: '#2D4657' },
];
