import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { useAuthStore, useFriendsStore } from '../stores';
import { Button } from '../components/Button';
import { Avatar } from '../components/Avatar';
import { formatCurrency, formatDate } from '../utils';
import type { Transfer, Friend } from '../types';

function ProfilePage() {
  const { user } = useAuthStore();
  const { friends, requests, loadFriends, loadRequests } = useFriendsStore();
  const [activeTab, setActiveTab] = useState<'activity' | 'friends'>('activity');
  const [transactions, setTransactions] = useState<Transfer[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (user) {
      Promise.all([
        api.getUserFeed(user.username).then(setTransactions).catch(() => {}),
        loadFriends(),
        loadRequests(),
      ]).finally(() => setIsLoading(false));
    }
  }, [user, loadFriends, loadRequests]);

  if (!user) return null;

  return (
    <div className="max-w-md mx-auto">
      {/* Profile Header */}
      <div className="bg-white rounded-lg shadow-sm p-6 mb-6 text-center">
        <Avatar src={user.avatar_url} name={user.name || user.username} size="lg" className="mx-auto mb-4" />
        <h1 className="text-xl font-bold">{user.name}</h1>
        <p className="text-gray-500">@{user.username}</p>

        <div className="flex justify-center gap-8 mt-4">
          <div>
            <p className="text-2xl font-bold text-venmo-blue">{formatCurrency(user.wallet?.balance || 0)}</p>
            <p className="text-sm text-gray-500">Balance</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{friends.length}</p>
            <p className="text-sm text-gray-500">Friends</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setActiveTab('activity')}
          className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
            activeTab === 'activity' ? 'bg-venmo-blue text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          Activity
        </button>
        <button
          onClick={() => setActiveTab('friends')}
          className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
            activeTab === 'friends' ? 'bg-venmo-blue text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          Friends
          {requests.length > 0 && (
            <span className="ml-1 bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full">
              {requests.length}
            </span>
          )}
        </button>
      </div>

      {activeTab === 'activity' && (
        <ActivityTab transactions={transactions} isLoading={isLoading} userId={user.id} />
      )}
      {activeTab === 'friends' && (
        <FriendsTab friends={friends} requests={requests} onUpdate={() => { loadFriends(); loadRequests(); }} />
      )}
    </div>
  );
}

function ActivityTab({ transactions, isLoading, userId }: { transactions: Transfer[]; isLoading: boolean; userId: string }) {
  if (isLoading) {
    return <div className="text-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-venmo-blue mx-auto"></div></div>;
  }

  if (transactions.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm p-8 text-center">
        <p className="text-gray-500">No activity yet</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm divide-y">
      {transactions.map((tx) => {
        const isSent = tx.sender_id === userId;
        return (
          <div key={tx.id} className="p-4">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">{isSent ? 'You' : tx.sender_name}</span>
              <span className="text-gray-500">paid</span>
              <span className="font-medium">{isSent ? tx.receiver_name : 'You'}</span>
              <span className={`ml-auto font-semibold ${isSent ? '' : 'text-green-600'}`}>
                {isSent ? '-' : '+'}{formatCurrency(tx.amount)}
              </span>
            </div>
            {tx.note && <p className="text-gray-700 mt-1">{tx.note}</p>}
            <p className="text-xs text-gray-400 mt-1">{formatDate(tx.created_at)}</p>
          </div>
        );
      })}
    </div>
  );
}

function FriendsTab({ friends, requests, onUpdate }: { friends: Friend[]; requests: Friend[]; onUpdate: () => void }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ id: string; username: string; name: string; avatar_url: string }>>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    const search = async () => {
      if (searchQuery.length < 2) {
        setSearchResults([]);
        return;
      }

      setIsSearching(true);
      try {
        const results = await api.searchUsers(searchQuery);
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    };

    const debounce = setTimeout(search, 300);
    return () => clearTimeout(debounce);
  }, [searchQuery]);

  const handleAddFriend = async (username: string) => {
    setActionLoading(username);
    try {
      await api.sendFriendRequest(username);
      onUpdate();
      setSearchResults(searchResults.filter(r => r.username !== username));
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to send request');
    } finally {
      setActionLoading(null);
    }
  };

  const handleAccept = async (username: string) => {
    setActionLoading(username);
    try {
      await api.acceptFriendRequest(username);
      onUpdate();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to accept');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDecline = async (username: string) => {
    setActionLoading(username);
    try {
      await api.declineFriendRequest(username);
      onUpdate();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to decline');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemove = async (username: string) => {
    if (!confirm(`Remove ${username} from friends?`)) return;
    setActionLoading(username);
    try {
      await api.removeFriend(username);
      onUpdate();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to remove');
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="bg-white rounded-lg shadow-sm p-4">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search for people..."
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-venmo-blue"
        />

        {isSearching && (
          <div className="text-center py-4">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-venmo-blue mx-auto"></div>
          </div>
        )}

        {searchResults.length > 0 && (
          <div className="mt-2 divide-y">
            {searchResults.map((u) => (
              <div key={u.id} className="py-3 flex items-center gap-3">
                <Avatar src={u.avatar_url} name={u.name} size="sm" />
                <div className="flex-1">
                  <p className="font-medium">{u.name}</p>
                  <p className="text-sm text-gray-500">@{u.username}</p>
                </div>
                <Button
                  onClick={() => handleAddFriend(u.username)}
                  size="sm"
                  loading={actionLoading === u.username}
                >
                  Add
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Friend Requests */}
      {requests.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm p-4">
          <h3 className="font-medium mb-3">Friend Requests</h3>
          <div className="divide-y">
            {requests.map((req) => (
              <div key={req.id} className="py-3 flex items-center gap-3">
                <Avatar src={req.avatar_url} name={req.name} size="sm" />
                <div className="flex-1">
                  <p className="font-medium">{req.name}</p>
                  <p className="text-sm text-gray-500">@{req.username}</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={() => handleAccept(req.username)}
                    size="sm"
                    disabled={actionLoading === req.username}
                  >
                    Accept
                  </Button>
                  <Button
                    onClick={() => handleDecline(req.username)}
                    variant="outline"
                    size="sm"
                    disabled={actionLoading === req.username}
                  >
                    Decline
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Friends List */}
      <div className="bg-white rounded-lg shadow-sm">
        <div className="p-4 border-b">
          <h3 className="font-medium">Friends ({friends.length})</h3>
        </div>
        {friends.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-gray-500">No friends yet. Search to add friends!</p>
          </div>
        ) : (
          <div className="divide-y">
            {friends.map((friend) => (
              <div key={friend.id} className="p-4 flex items-center gap-3">
                <Avatar src={friend.avatar_url} name={friend.name} size="sm" />
                <div className="flex-1">
                  <p className="font-medium">{friend.name}</p>
                  <p className="text-sm text-gray-500">@{friend.username}</p>
                </div>
                <button
                  onClick={() => handleRemove(friend.username)}
                  className="text-gray-400 hover:text-red-500"
                  disabled={actionLoading === friend.username}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M22 10.5h-6m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/profile')({
  component: ProfilePage,
});
