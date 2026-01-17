import { createFileRoute } from '@tanstack/react-router';
import { feedApi } from '../services/api';
import { TopicLinks } from '../components';
import { Tag } from 'lucide-react';

export const Route = createFileRoute('/topics/')({
  loader: async () => {
    const response = await feedApi.getTopics();
    return { topics: response.topics };
  },
  component: TopicsPage,
});

function TopicsPage() {
  const { topics } = Route.useLoaderData();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Tag className="w-8 h-8 text-primary-500" />
        <h1 className="text-2xl font-bold text-gray-900">Browse by Topic</h1>
      </div>

      <p className="text-gray-600">
        Explore news stories organized by topic
      </p>

      <TopicLinks topics={topics} />
    </div>
  );
}
