import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { libraryApi, playlistApi } from '../services/api';
import type { Track, Album, Artist, Playlist } from '../types';
import { AlbumCard } from '../components/TrackList';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/library')({
  component: LibraryPage,
});

type LibraryTab = 'playlists' | 'albums' | 'artists';

function LibraryPage() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading: authLoading } = useAuthStore();
  const [activeTab, setActiveTab] = useState<LibraryTab>('playlists');
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [artists, setArtists] = useState<Artist[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login' });
    }
  }, [isAuthenticated, authLoading, navigate]);

  useEffect(() => {
    if (!isAuthenticated) return;

    const fetchLibrary = async () => {
      setIsLoading(true);
      try {
        const [playlistsRes, albumsRes, artistsRes] = await Promise.all([
          playlistApi.getMyPlaylists({ limit: 50 }),
          libraryApi.getSavedAlbums({ limit: 50 }),
          libraryApi.getFollowedArtists({ limit: 50 }),
        ]);

        setPlaylists(playlistsRes.playlists);
        setAlbums(albumsRes.albums);
        setArtists(artistsRes.artists);
      } catch (error) {
        console.error('Failed to fetch library:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchLibrary();
  }, [isAuthenticated]);

  if (authLoading || !isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-spotify-green border-t-transparent"></div>
      </div>
    );
  }

  const handleCreatePlaylist = async () => {
    try {
      const playlist = await playlistApi.createPlaylist('New Playlist');
      setPlaylists([playlist, ...playlists]);
      navigate({ to: '/playlist/$playlistId', params: { playlistId: playlist.id } });
    } catch (error) {
      console.error('Failed to create playlist:', error);
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-white">Your Library</h1>
        <button
          onClick={handleCreatePlaylist}
          className="text-spotify-text hover:text-white p-2"
          title="Create playlist"
        >
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
          </svg>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        <TabButton
          active={activeTab === 'playlists'}
          onClick={() => setActiveTab('playlists')}
        >
          Playlists
        </TabButton>
        <TabButton
          active={activeTab === 'albums'}
          onClick={() => setActiveTab('albums')}
        >
          Albums
        </TabButton>
        <TabButton
          active={activeTab === 'artists'}
          onClick={() => setActiveTab('artists')}
        >
          Artists
        </TabButton>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-spotify-green border-t-transparent"></div>
        </div>
      ) : (
        <>
          {/* Playlists */}
          {activeTab === 'playlists' && (
            <div>
              {/* Liked Songs card */}
              <Link
                to="/library/liked"
                className="flex items-center gap-4 p-4 mb-4 rounded-lg bg-gradient-to-r from-purple-800 to-blue-600 hover:from-purple-700 hover:to-blue-500 transition-colors"
              >
                <div className="w-16 h-16 bg-gradient-to-br from-purple-600 to-blue-400 rounded flex items-center justify-center shadow-lg">
                  <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-xl font-bold text-white">Liked Songs</h3>
                  <p className="text-white/70 text-sm">Your favorite tracks</p>
                </div>
              </Link>

              {playlists.length > 0 ? (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                  {playlists.map((playlist) => (
                    <Link
                      key={playlist.id}
                      to="/playlist/$playlistId"
                      params={{ playlistId: playlist.id }}
                      className="group p-4 bg-spotify-dark-gray rounded-lg hover:bg-spotify-hover transition-colors"
                    >
                      <div className="relative mb-4">
                        <div className="aspect-square bg-spotify-light-gray rounded overflow-hidden shadow-lg">
                          {playlist.cover_url ? (
                            <img
                              src={playlist.cover_url}
                              alt={playlist.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-spotify-text bg-gradient-to-br from-gray-700 to-gray-900">
                              <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z" />
                              </svg>
                            </div>
                          )}
                        </div>
                        <button className="absolute bottom-2 right-2 w-12 h-12 bg-spotify-green rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all shadow-lg hover:scale-105">
                          <svg className="w-6 h-6 text-black" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        </button>
                      </div>
                      <p className="font-semibold text-white truncate mb-1">{playlist.name}</p>
                      <p className="text-sm text-spotify-text truncate">
                        Playlist - {playlist.track_count || 0} songs
                      </p>
                    </Link>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={
                    <svg className="w-16 h-16" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z" />
                    </svg>
                  }
                  title="Create your first playlist"
                  description="It's easy, we'll help you"
                  action={
                    <button
                      onClick={handleCreatePlaylist}
                      className="px-6 py-3 bg-white text-black font-semibold rounded-full hover:scale-105 transition-transform"
                    >
                      Create playlist
                    </button>
                  }
                />
              )}
            </div>
          )}

          {/* Albums */}
          {activeTab === 'albums' && (
            <div>
              {albums.length > 0 ? (
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
                  {albums.map((album) => (
                    <AlbumCard key={album.id} album={album} />
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={
                    <svg className="w-16 h-16" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z" />
                    </svg>
                  }
                  title="Save albums to your library"
                  description="Save albums by tapping the heart icon"
                  action={
                    <Link
                      to="/search"
                      className="px-6 py-3 bg-white text-black font-semibold rounded-full hover:scale-105 transition-transform inline-block"
                    >
                      Find albums
                    </Link>
                  }
                />
              )}
            </div>
          )}

          {/* Artists */}
          {activeTab === 'artists' && (
            <div>
              {artists.length > 0 ? (
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
                  {artists.map((artist) => (
                    <Link
                      key={artist.id}
                      to="/artist/$artistId"
                      params={{ artistId: artist.id }}
                      className="group p-4 bg-spotify-dark-gray rounded-lg hover:bg-spotify-hover transition-colors"
                    >
                      <div className="relative mb-4">
                        <div className="aspect-square bg-spotify-light-gray rounded-full overflow-hidden shadow-lg">
                          {artist.image_url ? (
                            <img
                              src={artist.image_url}
                              alt={artist.name}
                              className="w-full h-full object-cover"
                            />
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
              ) : (
                <EmptyState
                  icon={
                    <svg className="w-16 h-16" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                    </svg>
                  }
                  title="Follow your first artist"
                  description="Follow artists you like by tapping the follow button"
                  action={
                    <Link
                      to="/search"
                      className="px-6 py-3 bg-white text-black font-semibold rounded-full hover:scale-105 transition-transform inline-block"
                    >
                      Find artists
                    </Link>
                  }
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
        active
          ? 'bg-white text-black'
          : 'bg-spotify-light-gray text-white hover:bg-spotify-hover'
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="text-center py-16">
      <div className="text-spotify-text mb-4 flex justify-center">{icon}</div>
      <h3 className="text-xl font-bold text-white mb-2">{title}</h3>
      <p className="text-spotify-text mb-6">{description}</p>
      {action}
    </div>
  );
}
