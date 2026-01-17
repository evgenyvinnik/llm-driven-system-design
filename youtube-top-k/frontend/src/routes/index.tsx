import { createFileRoute } from '@tanstack/react-router';
import { useState, useCallback, useEffect } from 'react';
import { Header } from '../components/Header';
import { CategoryFilter } from '../components/CategoryFilter';
import { TrendingList } from '../components/TrendingList';
import { StatsPanel } from '../components/StatsPanel';
import { useSSE } from '../hooks/useSSE';
import { useTrendingStore } from '../stores/trendingStore';
import { fetchVideos, batchRecordViews, fetchAllTrending } from '../services/api';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const [isSimulating, setIsSimulating] = useState(false);
  const { setTrending } = useTrendingStore();

  // Connect to SSE for real-time updates
  useSSE();

  // Initial data fetch
  useEffect(() => {
    const loadInitialData = async () => {
      try {
        const trending = await fetchAllTrending();
        setTrending(trending);
      } catch (error) {
        console.error('Failed to load initial trending data:', error);
      }
    };
    loadInitialData();
  }, [setTrending]);

  const simulateViews = useCallback(async () => {
    setIsSimulating(true);
    try {
      // Fetch some videos to simulate views on
      const { videos } = await fetchVideos(1, 20);

      if (videos.length === 0) {
        console.warn('No videos available for simulation');
        return;
      }

      // Generate random views for random videos
      const viewsToRecord: { videoId: string; count: number }[] = [];
      const numVideos = Math.min(10, videos.length);

      for (let i = 0; i < numVideos; i++) {
        const randomIndex = Math.floor(Math.random() * videos.length);
        const video = videos[randomIndex];
        // Random count between 1 and 50
        const count = Math.floor(Math.random() * 50) + 1;
        viewsToRecord.push({ videoId: video.id, count });
      }

      await batchRecordViews(viewsToRecord);

      // Wait a bit for trending to update
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Refresh trending data
      const trending = await fetchAllTrending();
      setTrending(trending);
    } catch (error) {
      console.error('Simulation failed:', error);
    } finally {
      setIsSimulating(false);
    }
  }, [setTrending]);

  return (
    <div className="min-h-screen">
      <Header onSimulate={simulateViews} isSimulating={isSimulating} />

      <main className="max-w-7xl mx-auto px-4 py-6">
        <div className="mb-6">
          <CategoryFilter />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          <div className="lg:col-span-3">
            <TrendingList />
          </div>

          <div className="lg:col-span-1">
            <StatsPanel />
          </div>
        </div>
      </main>
    </div>
  );
}
