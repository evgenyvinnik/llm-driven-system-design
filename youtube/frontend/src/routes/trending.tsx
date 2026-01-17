import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useVideoStore } from '../stores/videoStore';
import VideoCard from '../components/VideoCard';

export const Route = createFileRoute('/trending')({
  component: TrendingPage,
});

function TrendingPage() {
  const { trending, isLoading, fetchTrending } = useVideoStore();

  useEffect(() => {
    fetchTrending();
  }, [fetchTrending]);

  return (
    <div className="p-6">
      <div className="flex items-center gap-4 mb-6">
        <div className="w-14 h-14 bg-gradient-to-r from-red-500 to-orange-500 rounded-full flex items-center justify-center">
          <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
            <path d="M17.53 11.2c-.23-.3-.5-.56-.76-.82-.65-.6-1.4-1.03-2.03-1.66C13.3 7.26 13 5.62 13.5 4c-1.75.63-3.08 2.15-3.65 3.83-.06.2-.1.4-.13.62-.17 1.22.13 2.53.84 3.55-.47.06-.9-.08-1.28-.37-.23-.18-.43-.43-.6-.72-.18-.3-.3-.63-.37-.97.02.01.05.03.07.04.57.36 1.26.54 1.97.54.53 0 1.06-.1 1.56-.3.47-.2.9-.5 1.25-.87l.04-.05c.76-.84 1.17-1.97 1.1-3.13-.07-.9-.43-1.77-1.03-2.45-.64-.75-1.52-1.27-2.5-1.47-.52-.1-1.06-.13-1.6-.08-.72.07-1.42.27-2.05.6-.32.17-.62.38-.9.62C5.6 4.17 5.09 5.35 5 6.58c-.02.27-.02.54 0 .8.05.65.22 1.28.5 1.86.26.54.62 1.03 1.05 1.46.4.4.86.76 1.36 1.05-.44.08-.88.13-1.32.13-.81 0-1.62-.16-2.36-.48v.06c0 .97.32 1.9.9 2.66.58.76 1.4 1.3 2.32 1.53-.45.12-.92.18-1.4.18-.33 0-.66-.03-.98-.1.32 1.02.97 1.9 1.86 2.52.9.62 1.96.96 3.06.96h.06c1.1 0 2.16-.34 3.06-.96.9-.62 1.56-1.5 1.88-2.52-.33.06-.67.1-1 .1-.48 0-.95-.06-1.4-.18.93-.24 1.74-.78 2.33-1.53.58-.76.9-1.7.9-2.66v-.06c-.75.32-1.56.48-2.37.48"/>
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold">Trending</h1>
          <p className="text-gray-400">Videos that are popular right now</p>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[...Array(10)].map((_, i) => (
            <div key={i} className="flex gap-4 animate-pulse">
              <div className="bg-yt-dark-hover aspect-video w-64 rounded-xl" />
              <div className="flex-1">
                <div className="h-5 bg-yt-dark-hover rounded mb-2" />
                <div className="h-4 bg-yt-dark-hover rounded w-1/3 mb-2" />
                <div className="h-3 bg-yt-dark-hover rounded w-1/4" />
              </div>
            </div>
          ))}
        </div>
      ) : trending.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-400 text-lg">No trending videos right now</p>
        </div>
      ) : (
        <div className="space-y-4">
          {trending.map((video, index) => (
            <div key={video.id} className="flex gap-4 items-start">
              <span className="text-2xl font-bold text-gray-500 w-8 text-center">
                {index + 1}
              </span>
              <div className="flex-1">
                <VideoCard video={video} layout="list" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
