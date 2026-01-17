import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { segments as segmentsApi } from '../services/api';
import { Segment } from '../types';
import { SegmentCard } from '../components/SegmentCard';

function SegmentsPage() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    const loadSegments = async () => {
      try {
        setLoading(true);
        const result = await segmentsApi.list({
          limit: 30,
          type: filter === 'all' ? undefined : filter,
          search: search || undefined,
        });
        setSegments(result.segments);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load segments');
      } finally {
        setLoading(false);
      }
    };

    const debounce = setTimeout(loadSegments, 300);
    return () => clearTimeout(debounce);
  }, [filter, search]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-strava-gray-800 mb-4">Segments</h1>

        <div className="flex flex-col md:flex-row gap-4">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search segments..."
            className="flex-1 px-4 py-2 border border-strava-gray-300 rounded-lg focus:ring-2 focus:ring-strava-orange focus:border-transparent"
          />

          <div className="flex gap-2">
            {['all', 'run', 'ride', 'hike'].map((type) => (
              <button
                key={type}
                onClick={() => setFilter(type)}
                className={`px-4 py-2 rounded-lg text-sm font-medium capitalize ${
                  filter === type
                    ? 'bg-strava-orange text-white'
                    : 'bg-strava-gray-100 text-strava-gray-700 hover:bg-strava-gray-200'
                }`}
              >
                {type}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="text-strava-gray-600">Loading segments...</div>
        </div>
      ) : error ? (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      ) : segments.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="text-4xl mb-4">🎯</div>
          <h2 className="text-xl font-semibold text-strava-gray-800 mb-2">
            No segments found
          </h2>
          <p className="text-strava-gray-600">
            {search
              ? 'Try a different search term.'
              : 'Segments are created from activities. Upload an activity to create segments!'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {segments.map((segment) => (
            <SegmentCard key={segment.id} segment={segment} />
          ))}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/segments')({
  component: SegmentsPage,
});
