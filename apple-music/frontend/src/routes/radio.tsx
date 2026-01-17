import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { radioApi } from '../services/api';
import { RadioStation } from '../types';
import { RadioStationCard } from '../components/MusicCards';

export const Route = createFileRoute('/radio')({
  component: Radio,
});

function Radio() {
  const [stations, setStations] = useState<RadioStation[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchStations = async () => {
      try {
        const { stations } = await radioApi.getStations();
        setStations(stations);
      } catch (error) {
        console.error('Failed to fetch radio stations:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchStations();
  }, []);

  if (isLoading) {
    return (
      <div className="p-8 flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-2 border-apple-red border-t-transparent rounded-full" />
      </div>
    );
  }

  // Group stations by type
  const curatedStations = stations.filter((s) => s.type === 'curated' || s.type === 'genre');
  const artistStations = stations.filter((s) => s.type === 'artist');

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Radio</h1>

      {/* Featured Banner */}
      <div className="mb-10 p-8 rounded-2xl bg-gradient-to-r from-apple-red to-apple-pink">
        <h2 className="text-2xl font-bold mb-2">Apple Music Radio</h2>
        <p className="text-white/80 mb-4">
          The best new music and icons of every genre. All for free.
        </p>
      </div>

      {/* Curated Stations */}
      {curatedStations.length > 0 && (
        <div className="mb-10">
          <h2 className="text-xl font-semibold mb-4">Featured Stations</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {curatedStations.map((station) => (
              <RadioStationCard key={station.id} station={station} />
            ))}
          </div>
        </div>
      )}

      {/* Artist Stations */}
      {artistStations.length > 0 && (
        <div className="mb-10">
          <h2 className="text-xl font-semibold mb-4">Artist Radio</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {artistStations.map((station) => (
              <RadioStationCard key={station.id} station={station} />
            ))}
          </div>
        </div>
      )}

      {stations.length === 0 && (
        <div className="text-center py-16">
          <p className="text-xl font-medium mb-2">No radio stations available</p>
          <p className="text-apple-text-secondary">
            Check back soon for more content.
          </p>
        </div>
      )}
    </div>
  );
}
