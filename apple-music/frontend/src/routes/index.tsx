import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { recommendationsApi } from '../services/api';
import { BrowseSection } from '../types';
import { AlbumCard, ArtistCard, TrackRow, RadioStationCard } from '../components/MusicCards';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/')({
  component: ListenNow,
});

function ListenNow() {
  const { user } = useAuthStore();
  const [sections, setSections] = useState<BrowseSection[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        if (user) {
          const { sections } = await recommendationsApi.getForYou();
          setSections(sections);
        } else {
          const { sections } = await recommendationsApi.getBrowse();
          setSections(sections);
        }
      } catch (error) {
        console.error('Failed to fetch recommendations:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [user]);

  if (isLoading) {
    return (
      <div className="p-8 flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-2 border-apple-red border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">
        {user ? 'Listen Now' : 'Welcome to Music'}
      </h1>

      {sections.map((section) => (
        <div key={section.id} className="mb-10">
          <h2 className="text-xl font-semibold mb-4">{section.title}</h2>

          {section.type === 'albums' && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-6">
              {(section.items as import('../types').Album[]).map((album) => (
                <AlbumCard key={album.id} album={album} />
              ))}
            </div>
          )}

          {section.type === 'artists' && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-6">
              {(section.items as import('../types').Artist[]).map((artist) => (
                <ArtistCard key={artist.id} artist={artist} />
              ))}
            </div>
          )}

          {section.type === 'tracks' && (
            <div className="bg-apple-card rounded-xl overflow-hidden">
              {(section.items as import('../types').Track[]).slice(0, 10).map((track, index) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  index={index}
                  tracks={section.items as import('../types').Track[]}
                />
              ))}
            </div>
          )}

          {section.type === 'radio' && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
              {(section.items as import('../types').RadioStation[]).map((station) => (
                <RadioStationCard key={station.id} station={station} />
              ))}
            </div>
          )}

          {section.type === 'genres' && (
            <div className="flex flex-wrap gap-3">
              {(section.items as { genre: string; track_count: number }[]).map((item) => (
                <a
                  key={item.genre}
                  href={`/browse?genre=${item.genre}`}
                  className="px-4 py-2 bg-apple-card rounded-full hover:bg-white/10 transition"
                >
                  {item.genre}
                </a>
              ))}
            </div>
          )}
        </div>
      ))}

      {sections.length === 0 && (
        <div className="text-center py-20">
          <p className="text-apple-text-secondary">No recommendations yet.</p>
          <p className="text-apple-text-secondary">Start listening to get personalized suggestions!</p>
        </div>
      )}
    </div>
  );
}
