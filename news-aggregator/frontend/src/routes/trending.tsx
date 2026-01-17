import { createFileRoute } from '@tanstack/react-router';
import { feedApi } from '../services/api';
import { StoryList } from '../components';
import { TrendingUp } from 'lucide-react';

export const Route = createFileRoute('/trending')({
  loader: async () => {
    const response = await feedApi.getTrending();
    return { stories: response.stories };
  },
  component: TrendingPage,
});

function TrendingPage() {
  const { stories } = Route.useLoaderData();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <TrendingUp className="w-8 h-8 text-orange-500" />
        <h1 className="text-2xl font-bold text-gray-900">Trending Stories</h1>
      </div>

      <p className="text-gray-600">
        Stories with the most coverage in the last 24 hours
      </p>

      <StoryList stories={stories} />
    </div>
  );
}
