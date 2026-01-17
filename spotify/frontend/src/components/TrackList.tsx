import { Link } from '@tanstack/react-router';
import type { Track, Album } from '../types';
import { usePlayerStore } from '../stores/playerStore';
import { formatDuration } from '../utils/format';

interface TrackListProps {
  tracks: Track[];
  showAlbum?: boolean;
  showNumber?: boolean;
  showArtist?: boolean;
  onPlay?: (track: Track, index: number) => void;
}

export function TrackList({ tracks, showAlbum = true, showNumber = true, showArtist = true, onPlay }: TrackListProps) {
  const { currentTrack, isPlaying, playTrack } = usePlayerStore();

  const handlePlay = (track: Track, index: number) => {
    if (onPlay) {
      onPlay(track, index);
    } else {
      playTrack(track, tracks);
    }
  };

  return (
    <div className="w-full">
      {/* Header */}
      <div className="grid grid-cols-[16px_4fr_2fr_1fr] gap-4 px-4 py-2 text-spotify-text text-xs border-b border-gray-700 sticky top-0 bg-spotify-black">
        {showNumber && <span className="text-center">#</span>}
        <span>TITLE</span>
        {showAlbum && <span>ALBUM</span>}
        <span className="text-right">
          <svg className="w-4 h-4 inline" fill="currentColor" viewBox="0 0 24 24">
            <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" />
          </svg>
        </span>
      </div>

      {/* Tracks */}
      <div className="divide-y divide-transparent">
        {tracks.map((track, index) => {
          const isCurrentTrack = currentTrack?.id === track.id;

          return (
            <div
              key={track.id}
              className={`grid grid-cols-[16px_4fr_2fr_1fr] gap-4 px-4 py-2 group hover:bg-spotify-hover rounded-md cursor-pointer ${
                isCurrentTrack ? 'text-spotify-green' : 'text-white'
              }`}
              onClick={() => handlePlay(track, index)}
            >
              {/* Number / Playing indicator */}
              {showNumber && (
                <div className="flex items-center justify-center">
                  {isCurrentTrack && isPlaying ? (
                    <div className="playing-indicator flex gap-0.5">
                      <span className="w-0.5 h-3 bg-spotify-green rounded"></span>
                      <span className="w-0.5 h-3 bg-spotify-green rounded"></span>
                      <span className="w-0.5 h-3 bg-spotify-green rounded"></span>
                    </div>
                  ) : (
                    <>
                      <span className="group-hover:hidden text-sm text-spotify-text">
                        {index + 1}
                      </span>
                      <button className="hidden group-hover:block text-white">
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* Title and Artist */}
              <div className="flex items-center gap-3 min-w-0">
                {showAlbum && track.album_cover_url && (
                  <img
                    src={track.album_cover_url}
                    alt={track.album_title}
                    className="w-10 h-10 rounded flex-shrink-0"
                  />
                )}
                <div className="min-w-0">
                  <p className={`truncate font-medium ${isCurrentTrack ? 'text-spotify-green' : 'text-white'}`}>
                    {track.title}
                  </p>
                  {showArtist && (
                    <p className="text-sm text-spotify-text truncate hover:underline">
                      {track.explicit && (
                        <span className="inline-flex items-center justify-center w-4 h-4 bg-spotify-text/30 text-[10px] rounded mr-1">
                          E
                        </span>
                      )}
                      <Link
                        to="/artist/$artistId"
                        params={{ artistId: track.artist_id || '' }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {track.artist_name}
                      </Link>
                    </p>
                  )}
                </div>
              </div>

              {/* Album */}
              {showAlbum && (
                <div className="flex items-center min-w-0">
                  <Link
                    to="/album/$albumId"
                    params={{ albumId: track.album_id }}
                    className="text-sm text-spotify-text truncate hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {track.album_title}
                  </Link>
                </div>
              )}

              {/* Duration */}
              <div className="flex items-center justify-end gap-4">
                <span className="text-sm text-spotify-text">
                  {formatDuration(track.duration_ms)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface AlbumCardProps {
  album: Album;
}

export function AlbumCard({ album }: AlbumCardProps) {
  return (
    <Link
      to="/album/$albumId"
      params={{ albumId: album.id }}
      className="group p-4 bg-spotify-dark-gray rounded-lg hover:bg-spotify-hover transition-colors"
    >
      <div className="relative mb-4">
        <div className="aspect-square bg-spotify-light-gray rounded-md overflow-hidden shadow-lg">
          {album.cover_url ? (
            <img src={album.cover_url} alt={album.title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-spotify-text">
              <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z" />
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
      <p className="font-semibold text-white truncate mb-1">{album.title}</p>
      <p className="text-sm text-spotify-text truncate">
        {album.release_date?.slice(0, 4)} - {album.artist_name}
      </p>
    </Link>
  );
}
