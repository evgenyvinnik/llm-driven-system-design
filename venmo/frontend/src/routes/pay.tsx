import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { useAuthStore, useFeedStore } from '../stores';
import { Button } from '../components/Button';
import { Input, TextArea } from '../components/Input';
import { Avatar } from '../components/Avatar';

function PayPage() {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'friends' | 'private'>('public');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [searchResults, setSearchResults] = useState<Array<{ id: string; username: string; name: string; avatar_url: string }>>([]);
  const [showSearch, setShowSearch] = useState(false);
  const [selectedUser, setSelectedUser] = useState<{ username: string; name: string; avatar_url: string } | null>(null);

  const { user, checkAuth } = useAuthStore();
  const { addItem } = useFeedStore();
  const navigate = useNavigate();

  useEffect(() => {
    const searchUsers = async () => {
      if (recipient.length < 2) {
        setSearchResults([]);
        return;
      }

      try {
        const results = await api.searchUsers(recipient);
        setSearchResults(results);
        setShowSearch(true);
      } catch {
        setSearchResults([]);
      }
    };

    const debounce = setTimeout(searchUsers, 300);
    return () => clearTimeout(debounce);
  }, [recipient]);

  const selectUser = (u: { username: string; name: string; avatar_url: string }) => {
    setSelectedUser(u);
    setRecipient(u.username);
    setShowSearch(false);
    setSearchResults([]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess(false);

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    if (amountNum > 5000) {
      setError('Maximum transfer amount is $5,000');
      return;
    }

    setLoading(true);

    try {
      const transfer = await api.sendMoney({
        recipientUsername: recipient,
        amount: amountNum,
        note,
        visibility,
      });

      addItem(transfer);
      await checkAuth(); // Refresh balance
      setSuccess(true);

      // Reset form
      setRecipient('');
      setAmount('');
      setNote('');
      setSelectedUser(null);

      // Navigate to feed after short delay
      setTimeout(() => navigate({ to: '/' }), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-md mx-auto">
      <h1 className="text-2xl font-bold mb-6">Pay</h1>

      {success ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            className="w-12 h-12 text-green-500 mx-auto mb-4"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <h2 className="text-lg font-medium text-green-800">Payment Sent!</h2>
          <p className="text-green-600 mt-1">Redirecting to feed...</p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-sm p-6 space-y-4">
          <div className="relative">
            <Input
              label="To"
              type="text"
              value={recipient}
              onChange={(e) => {
                setRecipient(e.target.value);
                setSelectedUser(null);
              }}
              placeholder="Enter username"
              required
            />

            {selectedUser && (
              <div className="mt-2 flex items-center gap-2 p-2 bg-blue-50 rounded-lg">
                <Avatar src={selectedUser.avatar_url} name={selectedUser.name} size="sm" />
                <div>
                  <p className="font-medium">{selectedUser.name}</p>
                  <p className="text-sm text-gray-500">@{selectedUser.username}</p>
                </div>
              </div>
            )}

            {showSearch && searchResults.length > 0 && (
              <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-auto">
                {searchResults.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => selectUser(u)}
                    className="w-full flex items-center gap-3 p-3 hover:bg-gray-50 transition-colors text-left"
                  >
                    <Avatar src={u.avatar_url} name={u.name} size="sm" />
                    <div>
                      <p className="font-medium">{u.name}</p>
                      <p className="text-sm text-gray-500">@{u.username}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Amount</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">$</span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                max="5000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                required
                className="w-full pl-8 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-venmo-blue focus:border-transparent"
              />
            </div>
            {user?.wallet && (
              <p className="mt-1 text-sm text-gray-500">
                Available balance: ${((user.wallet.balance || 0) / 100).toFixed(2)}
              </p>
            )}
          </div>

          <TextArea
            label="What's it for?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note..."
            rows={3}
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Visibility</label>
            <div className="flex gap-2">
              {(['public', 'friends', 'private'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVisibility(v)}
                  className={`px-3 py-1.5 rounded-full text-sm capitalize transition-colors ${
                    visibility === v
                      ? 'bg-venmo-blue text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <p className="text-red-500 text-sm text-center">{error}</p>
          )}

          <Button type="submit" className="w-full" loading={loading}>
            Pay
          </Button>
        </form>
      )}
    </div>
  );
}

export const Route = createFileRoute('/pay')({
  component: PayPage,
});
