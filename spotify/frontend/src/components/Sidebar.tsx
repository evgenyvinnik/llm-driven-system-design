import { Link, useLocation } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { playlistApi } from '../services/api';
import type { Playlist } from '../types';
import { useAuthStore } from '../stores/authStore';

export function Sidebar() {
  const location = useLocation();
  const { isAuthenticated } = useAuthStore();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);

  useEffect(() => {
    if (isAuthenticated) {
      playlistApi.getMyPlaylists({ limit: 20 }).then((res) => {
        setPlaylists(res.playlists);
      }).catch(console.error);
    }
  }, [isAuthenticated]);

  const isActive = (path: string) => location.pathname === path;

  return (
    <div className="w-64 bg-black flex flex-col h-full">
      {/* Logo */}
      <div className="p-6">
        <Link to="/" className="flex items-center gap-2 text-white">
          <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
          </svg>
          <span className="text-xl font-bold">Spotify</span>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="px-3">
        <Link
          to="/"
          className={`flex items-center gap-4 px-3 py-2 rounded-md transition-colors ${
            isActive('/') ? 'bg-spotify-light-gray text-white' : 'text-spotify-text hover:text-white'
          }`}
        >
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
          </svg>
          <span className="font-semibold">Home</span>
        </Link>

        <Link
          to="/search"
          className={`flex items-center gap-4 px-3 py-2 rounded-md transition-colors ${
            isActive('/search') ? 'bg-spotify-light-gray text-white' : 'text-spotify-text hover:text-white'
          }`}
        >
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
          </svg>
          <span className="font-semibold">Search</span>
        </Link>
      </nav>

      {/* Library */}
      <div className="mt-6 flex-1 overflow-hidden flex flex-col">
        <div className="px-6 flex items-center justify-between mb-4">
          <Link
            to="/library"
            className={`flex items-center gap-3 ${
              location.pathname.startsWith('/library') ? 'text-white' : 'text-spotify-text hover:text-white'
            }`}
          >
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9h-4v4h-2v-4H9V9h4V5h2v4h4v2z" />
            </svg>
            <span className="font-semibold">Your Library</span>
          </Link>
        </div>

        <div className="flex-1 overflow-y-auto px-2">
          {isAuthenticated && (
            <div className="space-y-1">
              <Link
                to="/library/liked"
                className={`flex items-center gap-3 p-2 rounded-md ${
                  isActive('/library/liked')
                    ? 'bg-spotify-light-gray text-white'
                    : 'text-spotify-text hover:bg-spotify-hover'
                }`}
              >
                <div className="w-12 h-12 bg-gradient-to-br from-purple-800 to-blue-400 rounded flex items-center justify-center">
                  <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-white text-sm font-medium truncate">Liked Songs</p>
                  <p className="text-spotify-text text-xs truncate">Playlist</p>
                </div>
              </Link>

              {playlists.map((playlist) => (
                <Link
                  key={playlist.id}
                  to="/playlist/$playlistId"
                  params={{ playlistId: playlist.id }}
                  className={`flex items-center gap-3 p-2 rounded-md ${
                    location.pathname === `/playlist/${playlist.id}`
                      ? 'bg-spotify-light-gray text-white'
                      : 'text-spotify-text hover:bg-spotify-hover'
                  }`}
                >
                  <div className="w-12 h-12 bg-spotify-light-gray rounded flex items-center justify-center flex-shrink-0">
                    {playlist.cover_url ? (
                      <img src={playlist.cover_url} alt={playlist.name} className="w-full h-full object-cover rounded" />
                    ) : (
                      <svg className="w-6 h-6 text-spotify-text" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z" />
                      </svg>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-white text-sm font-medium truncate">{playlist.name}</p>
                    <p className="text-spotify-text text-xs truncate">Playlist</p>
                  </div>
                </Link>
              ))}
            </div>
          )}

          {!isAuthenticated && (
            <div className="p-4 bg-spotify-light-gray rounded-lg">
              <p className="text-white text-sm font-semibold mb-2">Create your first playlist</p>
              <p className="text-spotify-text text-xs mb-4">It's easy, we'll help you</p>
              <Link
                to="/login"
                className="inline-block px-4 py-2 bg-white text-black text-sm font-semibold rounded-full hover:scale-105 transition-transform"
              >
                Log in
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
