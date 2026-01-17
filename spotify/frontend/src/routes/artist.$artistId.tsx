import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { catalogApi, libraryApi } from '../services/api';
import type { Artist, Track } from '../types';
import { AlbumCard } from '../components/TrackList';
import { usePlayerStore } from '../stores/playerStore';
import { useAuthStore } from '../stores/authStore';
import { formatPlayCount, formatDuration } from '../utils/format';

export const Route = createFileRoute('/artist/$artistId')({
  component: ArtistPage,
});

function ArtistPage() {
  const { artistId } = Route.useParams();
  const { isAuthenticated } = useAuthStore();
  const [artist, setArtist] = useState<Artist | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isFollowing, setIsFollowing] = useState(false);
  const { playTrack, playQueue, currentTrack, isPlaying, togglePlay } = usePlayerStore();

  useEffect(() => {
    const fetchArtist = async () => {
      try {
        const data = await catalogApi.getArtist(artistId);
        setArtist(data);
      } catch (error) {
        console.error('Failed to fetch artist:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchArtist();
  }, [artistId]);

  const handleFollow = async () => {
    if (!isAuthenticated || !artist) return;

    try {
      if (isFollowing) {
        await libraryApi.unfollowArtist(artist.id);
        setIsFollowing(false);
      } else {
        await libraryApi.followArtist(artist.id);
        setIsFollowing(true);
      }
    } catch (error) {
      console.error('Failed to follow/unfollow:', error);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-spotify-green border-t-transparent"></div>
      </div>
    );
  }

  if (!artist) {
    return (
      <div className="text-center py-16">
        <h2 className="text-2xl font-bold text-white mb-2">Artist not found</h2>
        <Link to="/" className="text-spotify-green hover:underline">
          Go back home
        </Link>
      </div>
    );
  }

  const topTracks = artist.topTracks || [];
  const albums = artist.albums || [];
  const isPlayingArtist = currentTrack && topTracks.some(t => t.id === currentTrack.id) && isPlaying;

  const handlePlayArtist = () => {
    if (isPlayingArtist) {
      togglePlay();
    } else if (topTracks.length > 0) {
      playQueue(topTracks, 0);
    }
  };

  return (
    <div>
      {/* Header */}
      <div
        className="relative -mx-6 -mt-6 px-6 pt-32 pb-6 bg-gradient-to-b from-spotify-light-gray/50 to-transparent"
        style={{
          backgroundImage: artist.image_url
            ? `linear-gradient(transparent 0%, rgba(18, 18, 18, 0.5) 50%, #121212 100%), url(${artist.image_url})`
            : undefined,
          backgroundSize: 'cover',
          backgroundPosition: 'center 30%',
        }}
      >
        <div className="flex items-center gap-2 mb-4">
          {artist.verified && (
            <div className="flex items-center gap-1 text-white text-sm">
              <svg className="w-6 h-6 text-blue-400" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z" />
              </svg>
              <span>Verified Artist</span>
            </div>
          )}
        </div>
        <h1 className="text-7xl font-bold text-white mb-6">{artist.name}</h1>
        <p className="text-white">{formatPlayCount(artist.monthly_listeners)} monthly listeners</p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-6 my-6">
        <button
          onClick={handlePlayArtist}
          className="w-14 h-14 bg-spotify-green rounded-full flex items-center justify-center hover:scale-105 transition-transform shadow-lg"
        >
          {isPlayingArtist ? (
            <svg className="w-8 h-8 text-black" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            </svg>
          ) : (
            <svg className="w-8 h-8 text-black" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        {isAuthenticated && (
          <button
            onClick={handleFollow}
            className={`px-4 py-2 rounded-full text-sm font-bold border ${
              isFollowing
                ? 'border-white text-white'
                : 'border-spotify-text text-white hover:border-white'
            }`}
          >
            {isFollowing ? 'Following' : 'Follow'}
          </button>
        )}
      </div>

      {/* Popular tracks */}
      {topTracks.length > 0 && (
        <section className="mb-8">
          <h2 className="text-2xl font-bold text-white mb-4">Popular</h2>
          <div className="space-y-1">
            {topTracks.slice(0, 5).map((track, index) => (
              <PopularTrackRow
                key={track.id}
                track={track}
                index={index}
                allTracks={topTracks}
              />
            ))}
          </div>
        </section>
      )}

      {/* Discography */}
      {albums.length > 0 && (
        <section>
          <h2 className="text-2xl font-bold text-white mb-4">Discography</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
            {albums.map((album) => (
              <AlbumCard key={album.id} album={{ ...album, artist_name: artist.name }} />
            ))}
          </div>
        </section>
      )}

      {/* About */}
      {artist.bio && (
        <section className="mt-8">
          <h2 className="text-2xl font-bold text-white mb-4">About</h2>
          <div className="max-w-2xl">
            <p className="text-spotify-text leading-relaxed">{artist.bio}</p>
          </div>
        </section>
      )}
    </div>
  );
}

function PopularTrackRow({
  track,
  index,
  allTracks,
}: {
  track: Track;
  index: number;
  allTracks: Track[];
}) {
  const { playTrack, currentTrack, isPlaying } = usePlayerStore();
  const isCurrentTrack = currentTrack?.id === track.id;

  return (
    <div
      onClick={() => playTrack(track, allTracks)}
      className={`flex items-center gap-4 p-2 rounded group hover:bg-spotify-hover cursor-pointer ${
        isCurrentTrack ? 'text-spotify-green' : 'text-white'
      }`}
    >
      <div className="w-6 text-center text-spotify-text">
        {isCurrentTrack && isPlaying ? (
          <div className="playing-indicator flex gap-0.5 justify-center">
            <span className="w-0.5 h-3 bg-spotify-green rounded"></span>
            <span className="w-0.5 h-3 bg-spotify-green rounded"></span>
            <span className="w-0.5 h-3 bg-spotify-green rounded"></span>
          </div>
        ) : (
          <>
            <span className="group-hover:hidden">{index + 1}</span>
            <svg className="w-4 h-4 hidden group-hover:block mx-auto text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </>
        )}
      </div>
      <div className="w-10 h-10 bg-spotify-light-gray rounded flex-shrink-0 overflow-hidden">
        {track.album_cover_url && (
          <img src={track.album_cover_url} alt={track.album_title} className="w-full h-full object-cover" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`truncate font-medium ${isCurrentTrack ? 'text-spotify-green' : 'text-white'}`}>
          {track.title}
        </p>
      </div>
      <div className="text-spotify-text text-sm">
        {formatPlayCount(track.stream_count)}
      </div>
      <div className="text-spotify-text text-sm w-12 text-right">
        {formatDuration(track.duration_ms)}
      </div>
    </div>
  );
}
