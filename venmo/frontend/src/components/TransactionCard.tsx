import type { Transfer } from '../types';
import { Avatar } from './Avatar';
import { formatCurrency, formatDate } from '../utils';
import { useState } from 'react';
import { api } from '../services/api';
import { useFeedStore } from '../stores';

interface TransactionCardProps {
  transaction: Transfer;
  currentUserId?: string;
}

export function TransactionCard({ transaction, currentUserId }: TransactionCardProps) {
  const [liked, setLiked] = useState(transaction.user_liked || false);
  const [likesCount, setLikesCount] = useState(transaction.likes_count || 0);
  const [isLiking, setIsLiking] = useState(false);
  const updateItem = useFeedStore((state) => state.updateItem);

  const isSender = transaction.sender_id === currentUserId;
  const isReceiver = transaction.receiver_id === currentUserId;

  const handleLike = async () => {
    if (isLiking) return;
    setIsLiking(true);

    try {
      if (liked) {
        const result = await api.unlikeTransfer(transaction.id);
        setLiked(false);
        setLikesCount(result.likes_count);
        updateItem(transaction.id, { user_liked: false, likes_count: result.likes_count });
      } else {
        const result = await api.likeTransfer(transaction.id);
        setLiked(true);
        setLikesCount(result.likes_count);
        updateItem(transaction.id, { user_liked: true, likes_count: result.likes_count });
      }
    } catch (error) {
      console.error('Like error:', error);
    } finally {
      setIsLiking(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm p-4 mb-3">
      <div className="flex items-start gap-3">
        <Avatar src={transaction.sender_avatar} name={transaction.sender_name} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`font-medium ${isSender ? 'text-venmo-blue' : ''}`}>
              {isSender ? 'You' : transaction.sender_name}
            </span>
            <span className="text-gray-500">paid</span>
            <span className={`font-medium ${isReceiver ? 'text-venmo-blue' : ''}`}>
              {isReceiver ? 'You' : transaction.receiver_name}
            </span>
          </div>

          {transaction.note && (
            <p className="text-gray-700 mt-1">{transaction.note}</p>
          )}

          <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
            <span>{formatDate(transaction.created_at)}</span>

            <button
              onClick={handleLike}
              disabled={isLiking}
              className={`flex items-center gap-1 hover:text-red-500 transition-colors ${liked ? 'text-red-500' : ''}`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill={liked ? 'currentColor' : 'none'}
                stroke="currentColor"
                className="w-5 h-5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={liked ? 0 : 1.5}
                  d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z"
                />
              </svg>
              {likesCount > 0 && <span>{likesCount}</span>}
            </button>

            {transaction.comments_count !== undefined && transaction.comments_count > 0 && (
              <span className="flex items-center gap-1">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  className="w-5 h-5"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"
                  />
                </svg>
                {transaction.comments_count}
              </span>
            )}

            {transaction.visibility !== 'public' && (
              <span className="text-xs bg-gray-100 px-2 py-0.5 rounded">
                {transaction.visibility}
              </span>
            )}
          </div>
        </div>

        <div className={`text-lg font-semibold ${isReceiver ? 'text-green-600' : isSender ? 'text-gray-900' : 'text-gray-600'}`}>
          {isReceiver ? '+' : isSender ? '-' : ''}{formatCurrency(transaction.amount)}
        </div>
      </div>
    </div>
  );
}
