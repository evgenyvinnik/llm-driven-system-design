import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Play, Shuffle } from 'lucide-react';
import { radioApi } from '../../services/api';
import { RadioStation, Track } from '../../types';
import { TrackRow } from '../../components/MusicCards';
import { usePlayerStore } from '../../stores/playerStore';

export const Route = createFileRoute('/radio/$id')({
  component: RadioStationPage,
});

function RadioStationPage() {
  const { id } = Route.useParams();
  const { playQueue } = usePlayerStore();
  const [station, setStation] = useState<RadioStation | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchStation = async () => {
      try {
        const data = await radioApi.getStation(id);
        setStation(data);
      } catch (error) {
        console.error('Failed to fetch station:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchStation();
  }, [id]);

  const handlePlay = () => {
    if (station?.tracks && station.tracks.length > 0) {
      playQueue(station.tracks);
    }
  };

  const handleShuffle = async () => {
    try {
      const { tracks } = await radioApi.getStationTracks(id, true);
      if (tracks.length > 0) {
        playQueue(tracks);
      }
    } catch (error) {
      console.error('Failed to shuffle:', error);
    }
  };

  if (isLoading) {
    return (
      <div className="p-8 flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-2 border-apple-red border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!station) {
    return (
      <div className="p-8 text-center">
        <p className="text-xl">Radio station not found</p>
      </div>
    );
  }

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row gap-8 mb-8">
        {/* Artwork */}
        <div className="w-64 h-64 rounded-xl overflow-hidden flex-shrink-0 shadow-2xl bg-gradient-to-br from-apple-red to-apple-pink">
          {station.artwork_url ? (
            <img src={station.artwork_url} alt={station.name} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-6xl font-bold text-white/80">{station.name[0]}</span>
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex flex-col justify-end">
          <p className="text-sm text-apple-text-secondary uppercase tracking-wider mb-2">
            Radio Station
          </p>
          <h1 className="text-4xl font-bold mb-2">{station.name}</h1>
          {station.description && (
            <p className="text-apple-text-secondary mb-4 max-w-xl">{station.description}</p>
          )}

          <div className="flex items-center gap-4 text-sm text-apple-text-secondary mb-6">
            {station.seed_genre && (
              <span className="px-3 py-1 bg-apple-card rounded-full">{station.seed_genre}</span>
            )}
            {station.seed_artist_name && (
              <span>Based on {station.seed_artist_name}</span>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-4">
            <button
              onClick={handlePlay}
              disabled={!station.tracks || station.tracks.length === 0}
              className="flex items-center gap-2 px-6 py-3 bg-apple-red hover:bg-apple-red/80 rounded-full font-medium transition disabled:opacity-50"
            >
              <Play className="w-5 h-5" />
              Play
            </button>

            <button
              onClick={handleShuffle}
              className="flex items-center gap-2 px-6 py-3 bg-apple-card hover:bg-white/10 border border-apple-border rounded-full font-medium transition"
            >
              <Shuffle className="w-5 h-5" />
              Shuffle
            </button>
          </div>
        </div>
      </div>

      {/* Tracks */}
      {station.tracks && station.tracks.length > 0 ? (
        <div className="bg-apple-card rounded-xl overflow-hidden">
          {station.tracks.map((track, index) => (
            <TrackRow
              key={track.id}
              track={track}
              index={index}
              tracks={station.tracks}
            />
          ))}
        </div>
      ) : (
        <div className="text-center py-16 bg-apple-card rounded-xl">
          <p className="text-xl font-medium mb-2">No tracks available</p>
          <p className="text-apple-text-secondary">
            This station doesn't have any tracks yet.
          </p>
        </div>
      )}
    </div>
  );
}
