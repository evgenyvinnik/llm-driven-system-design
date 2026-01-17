/**
 * Topic display components for filtering and browsing.
 * @module components/TopicBadges
 */

import { Link } from '@tanstack/react-router';
import type { Topic } from '../types';

/**
 * Props for the TopicBadges component.
 */
interface TopicBadgesProps {
  /** Array of topics with story counts */
  topics: Topic[];
  /** Currently selected topic (null for "All") */
  selected?: string | null;
  /** Callback when topic selection changes */
  onSelect?: (topic: string | null) => void;
}

/**
 * Horizontal list of topic filter badges.
 * Includes an "All" option and highlights the selected topic.
 * Used for filtering the feed by topic.
 * @param props - Component props
 * @param props.topics - Array of topics with counts
 * @param props.selected - Currently selected topic
 * @param props.onSelect - Selection change handler
 * @returns Flex container with topic filter badges
 */
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

/**
 * Props for the TopicLinks component.
 */
interface TopicLinksProps {
  /** Array of topics with story counts */
  topics: Topic[];
}

/**
 * Grid of topic cards linking to topic pages.
 * Each card shows the topic name and story count.
 * Used for the topics index page to browse all topics.
 * @param props - Component props
 * @param props.topics - Array of topics with counts
 * @returns Grid of linked topic cards
 */
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
