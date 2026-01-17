import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore, useFeedStore } from '../stores';
import { TransactionCard } from '../components/TransactionCard';

function FeedPage() {
  const { user } = useAuthStore();
  const { items, isLoading, loadFeed, loadGlobalFeed } = useFeedStore();
  const [feedType, setFeedType] = useState<'friends' | 'global'>('friends');

  useEffect(() => {
    if (feedType === 'friends') {
      loadFeed();
    } else {
      loadGlobalFeed();
    }
  }, [feedType, loadFeed, loadGlobalFeed]);

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setFeedType('friends')}
          className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
            feedType === 'friends'
              ? 'bg-venmo-blue text-white'
              : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          Friends
        </button>
        <button
          onClick={() => setFeedType('global')}
          className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
            feedType === 'global'
              ? 'bg-venmo-blue text-white'
              : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          Global
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-venmo-blue mx-auto"></div>
          <p className="mt-2 text-gray-500">Loading feed...</p>
        </div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm p-8 text-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="w-12 h-12 text-gray-300 mx-auto mb-4"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <h3 className="text-lg font-medium text-gray-900 mb-2">No transactions yet</h3>
          <p className="text-gray-500">
            {feedType === 'friends'
              ? 'Add friends and make payments to see activity here.'
              : 'Be the first to make a public transaction!'}
          </p>
        </div>
      ) : (
        <div>
          {items.map((transaction) => (
            <TransactionCard
              key={transaction.id}
              transaction={transaction}
              currentUserId={user?.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/')({
  component: FeedPage,
});
