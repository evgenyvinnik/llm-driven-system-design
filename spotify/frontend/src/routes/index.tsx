import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { catalogApi, recommendationsApi } from '../services/api';
import type { Album, Track } from '../types';
import { AlbumCard } from '../components/TrackList';
import { usePlayerStore } from '../stores/playerStore';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const { isAuthenticated } = useAuthStore();
  const { playTrack } = usePlayerStore();
  const [newReleases, setNewReleases] = useState<Album[]>([]);
  const [featuredTracks, setFeaturedTracks] = useState<Track[]>([]);
  const [popularTracks, setPopularTracks] = useState<Track[]>([]);
  const [forYouTracks, setForYouTracks] = useState<Track[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [newReleasesRes, featuredRes, popularRes] = await Promise.all([
          catalogApi.getNewReleases(12),
          catalogApi.getFeatured(10),
          recommendationsApi.getPopular(20),
        ]);

        setNewReleases(newReleasesRes.albums);
        setFeaturedTracks(featuredRes.tracks);
        setPopularTracks(popularRes.tracks);

        if (isAuthenticated) {
          try {
            const forYouRes = await recommendationsApi.getForYou(20);
            setForYouTracks(forYouRes.tracks);
          } catch (error) {
            console.error('Failed to fetch recommendations:', error);
          }
        }
      } catch (error) {
        console.error('Failed to fetch home data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [isAuthenticated]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-spotify-green border-t-transparent"></div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Greeting */}
      <section>
        <h1 className="text-3xl font-bold text-white mb-6">
          {getGreeting()}
        </h1>

        {/* Quick play cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {featuredTracks.slice(0, 8).map((track) => (
            <button
              key={track.id}
              onClick={() => playTrack(track, featuredTracks)}
              className="flex items-center bg-white/10 hover:bg-white/20 rounded overflow-hidden group transition-colors"
            >
              <div className="w-16 h-16 bg-spotify-light-gray flex-shrink-0">
                {track.album_cover_url && (
                  <img
                    src={track.album_cover_url}
                    alt={track.album_title}
                    className="w-full h-full object-cover"
                  />
                )}
              </div>
              <span className="px-4 font-semibold text-white text-sm truncate flex-1 text-left">
                {track.title}
              </span>
              <div className="pr-4 opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="w-10 h-10 bg-spotify-green rounded-full flex items-center justify-center shadow-lg">
                  <svg className="w-5 h-5 text-black" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* For You - Personalized (authenticated only) */}
      {isAuthenticated && forYouTracks.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-bold text-white">Made for You</h2>
            <Link to="/library" className="text-sm text-spotify-text hover:underline font-semibold">
              Show all
            </Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
            {forYouTracks.slice(0, 6).map((track) => (
              <TrackCard key={track.id} track={track} allTracks={forYouTracks} />
            ))}
          </div>
        </section>
      )}

      {/* Popular Tracks */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">Popular Right Now</h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
          {popularTracks.slice(0, 6).map((track) => (
            <TrackCard key={track.id} track={track} allTracks={popularTracks} />
          ))}
        </div>
      </section>

      {/* New Releases */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">New Releases</h2>
          <Link to="/search" className="text-sm text-spotify-text hover:underline font-semibold">
            Show all
          </Link>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
          {newReleases.slice(0, 6).map((album) => (
            <AlbumCard key={album.id} album={album} />
          ))}
        </div>
      </section>
    </div>
  );
}

function TrackCard({ track, allTracks }: { track: Track; allTracks: Track[] }) {
  const { playTrack, currentTrack, isPlaying } = usePlayerStore();
  const isCurrentTrack = currentTrack?.id === track.id;

  return (
    <button
      onClick={() => playTrack(track, allTracks)}
      className="group p-4 bg-spotify-dark-gray rounded-lg hover:bg-spotify-hover transition-colors text-left"
    >
      <div className="relative mb-4">
        <div className="aspect-square bg-spotify-light-gray rounded-md overflow-hidden shadow-lg">
          {track.album_cover_url ? (
            <img src={track.album_cover_url} alt={track.album_title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-spotify-text">
              <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
              </svg>
            </div>
          )}
        </div>
        <div
          className={`absolute bottom-2 right-2 w-12 h-12 bg-spotify-green rounded-full flex items-center justify-center shadow-lg hover:scale-105 transition-all ${
            isCurrentTrack ? 'opacity-100 translate-y-0' : 'opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0'
          }`}
        >
          {isCurrentTrack && isPlaying ? (
            <svg className="w-6 h-6 text-black" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            </svg>
          ) : (
            <svg className="w-6 h-6 text-black" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </div>
      </div>
      <p className={`font-semibold truncate mb-1 ${isCurrentTrack ? 'text-spotify-green' : 'text-white'}`}>
        {track.title}
      </p>
      <p className="text-sm text-spotify-text truncate">{track.artist_name}</p>
    </button>
  );
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
