import { Link } from '@tanstack/react-router';
import type { Topic } from '../types';

interface TopicBadgesProps {
  topics: Topic[];
  selected?: string | null;
  onSelect?: (topic: string | null) => void;
}

export function TopicBadges({ topics, selected, onSelect }: TopicBadgesProps) {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        onClick={() => onSelect?.(null)}
        className={`px-3 py-1.5 text-sm font-medium rounded-full transition-colors ${
          selected === null
            ? 'bg-primary-600 text-white'
            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
        }`}
      >
        All
      </button>
      {topics.map((topic) => (
        <button
          key={topic.topic}
          onClick={() => onSelect?.(topic.topic)}
          className={`px-3 py-1.5 text-sm font-medium rounded-full transition-colors ${
            selected === topic.topic
              ? 'bg-primary-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          {topic.topic}
          <span className="ml-1 text-xs opacity-75">({topic.count})</span>
        </button>
      ))}
    </div>
  );
}

interface TopicLinksProps {
  topics: Topic[];
}

export function TopicLinks({ topics }: TopicLinksProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {topics.map((topic) => (
        <Link
          key={topic.topic}
          to="/topics/$topic"
          params={{ topic: topic.topic }}
          className="card flex items-center justify-between"
        >
          <span className="font-medium text-gray-900 capitalize">{topic.topic}</span>
          <span className="text-sm text-gray-500">{topic.count} stories</span>
        </Link>
      ))}
    </div>
  );
}
