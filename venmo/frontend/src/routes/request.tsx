import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { useRequestsStore, useAuthStore } from '../stores';
import { Button } from '../components/Button';
import { Input, TextArea } from '../components/Input';
import { Avatar } from '../components/Avatar';
import { formatCurrency, formatDate } from '../utils';
import type { PaymentRequest } from '../types';

function RequestPage() {
  const [activeTab, setActiveTab] = useState<'create' | 'received' | 'sent'>('create');
  const { sent, received, isLoading, loadRequests } = useRequestsStore();

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  return (
    <div className="max-w-md mx-auto">
      <div className="flex gap-2 mb-6 overflow-x-auto">
        {(['create', 'received', 'sent'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
              activeTab === tab
                ? 'bg-venmo-blue text-white'
                : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            {tab === 'create' ? 'Request Money' : tab.charAt(0).toUpperCase() + tab.slice(1)}
            {tab === 'received' && received.filter(r => r.status === 'pending').length > 0 && (
              <span className="ml-1 bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full">
                {received.filter(r => r.status === 'pending').length}
              </span>
            )}
          </button>
        ))}
      </div>

      {activeTab === 'create' && <CreateRequestForm onSuccess={loadRequests} />}
      {activeTab === 'received' && <ReceivedRequests requests={received} isLoading={isLoading} onUpdate={loadRequests} />}
      {activeTab === 'sent' && <SentRequests requests={sent} isLoading={isLoading} onUpdate={loadRequests} />}
    </div>
  );
}

function CreateRequestForm({ onSuccess }: { onSuccess: () => void }) {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [searchResults, setSearchResults] = useState<Array<{ id: string; username: string; name: string; avatar_url: string }>>([]);
  const [showSearch, setShowSearch] = useState(false);
  const [selectedUser, setSelectedUser] = useState<{ username: string; name: string; avatar_url: string } | null>(null);

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

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    setLoading(true);

    try {
      await api.createRequest({
        recipientUsername: recipient,
        amount: amountNum,
        note,
      });

      setSuccess(true);
      setRecipient('');
      setAmount('');
      setNote('');
      setSelectedUser(null);
      onSuccess();

      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {success && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4 text-center">
          <p className="text-green-800 font-medium">Request sent!</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-sm p-6 space-y-4">
        <h2 className="text-lg font-semibold">Request Money</h2>

        <div className="relative">
          <Input
            label="From"
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
        </div>

        <TextArea
          label="What's it for?"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note..."
          rows={3}
        />

        {error && <p className="text-red-500 text-sm text-center">{error}</p>}

        <Button type="submit" className="w-full" loading={loading}>
          Request
        </Button>
      </form>
    </>
  );
}

function ReceivedRequests({ requests, isLoading, onUpdate }: { requests: PaymentRequest[]; isLoading: boolean; onUpdate: () => void }) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const { checkAuth } = useAuthStore();

  const handlePay = async (request: PaymentRequest) => {
    setActionLoading(request.id);
    try {
      await api.payRequest(request.id);
      await checkAuth();
      onUpdate();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Payment failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDecline = async (request: PaymentRequest) => {
    setActionLoading(request.id);
    try {
      await api.declineRequest(request.id);
      onUpdate();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to decline');
    } finally {
      setActionLoading(null);
    }
  };

  if (isLoading) {
    return <div className="text-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-venmo-blue mx-auto"></div></div>;
  }

  const pending = requests.filter(r => r.status === 'pending');
  const completed = requests.filter(r => r.status !== 'pending');

  return (
    <div className="space-y-4">
      {pending.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-500 mb-2">Pending</h3>
          {pending.map((request) => (
            <div key={request.id} className="bg-white rounded-lg shadow-sm p-4 mb-3">
              <div className="flex items-start gap-3">
                <Avatar src={request.requester_avatar} name={request.requester_name || ''} />
                <div className="flex-1">
                  <p className="font-medium">{request.requester_name}</p>
                  <p className="text-gray-500 text-sm">@{request.requester_username}</p>
                  {request.note && <p className="text-gray-700 mt-1">{request.note}</p>}
                  <p className="text-sm text-gray-400 mt-1">{formatDate(request.created_at)}</p>
                </div>
                <p className="text-lg font-semibold">{formatCurrency(request.amount)}</p>
              </div>
              <div className="flex gap-2 mt-4">
                <Button
                  onClick={() => handlePay(request)}
                  loading={actionLoading === request.id}
                  size="sm"
                  className="flex-1"
                >
                  Pay
                </Button>
                <Button
                  onClick={() => handleDecline(request)}
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  disabled={actionLoading === request.id}
                >
                  Decline
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {completed.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-500 mb-2">Completed</h3>
          {completed.map((request) => (
            <div key={request.id} className="bg-white rounded-lg shadow-sm p-4 mb-3 opacity-75">
              <div className="flex items-start gap-3">
                <Avatar src={request.requester_avatar} name={request.requester_name || ''} />
                <div className="flex-1">
                  <p className="font-medium">{request.requester_name}</p>
                  {request.note && <p className="text-gray-700 mt-1">{request.note}</p>}
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold">{formatCurrency(request.amount)}</p>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    request.status === 'paid' ? 'bg-green-100 text-green-700' :
                    request.status === 'declined' ? 'bg-red-100 text-red-700' :
                    'bg-gray-100 text-gray-700'
                  }`}>
                    {request.status}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {requests.length === 0 && (
        <div className="bg-white rounded-lg shadow-sm p-8 text-center">
          <p className="text-gray-500">No received requests</p>
        </div>
      )}
    </div>
  );
}

function SentRequests({ requests, isLoading, onUpdate }: { requests: PaymentRequest[]; isLoading: boolean; onUpdate: () => void }) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleCancel = async (request: PaymentRequest) => {
    setActionLoading(request.id);
    try {
      await api.cancelRequest(request.id);
      onUpdate();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to cancel');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemind = async (request: PaymentRequest) => {
    setActionLoading(request.id);
    try {
      await api.remindRequest(request.id);
      alert('Reminder sent!');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to send reminder');
    } finally {
      setActionLoading(null);
    }
  };

  if (isLoading) {
    return <div className="text-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-venmo-blue mx-auto"></div></div>;
  }

  const pending = requests.filter(r => r.status === 'pending');
  const completed = requests.filter(r => r.status !== 'pending');

  return (
    <div className="space-y-4">
      {pending.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-500 mb-2">Pending</h3>
          {pending.map((request) => (
            <div key={request.id} className="bg-white rounded-lg shadow-sm p-4 mb-3">
              <div className="flex items-start gap-3">
                <Avatar src={request.requestee_avatar} name={request.requestee_name || ''} />
                <div className="flex-1">
                  <p className="font-medium">{request.requestee_name}</p>
                  <p className="text-gray-500 text-sm">@{request.requestee_username}</p>
                  {request.note && <p className="text-gray-700 mt-1">{request.note}</p>}
                  <p className="text-sm text-gray-400 mt-1">{formatDate(request.created_at)}</p>
                </div>
                <p className="text-lg font-semibold">{formatCurrency(request.amount)}</p>
              </div>
              <div className="flex gap-2 mt-4">
                <Button
                  onClick={() => handleRemind(request)}
                  variant="secondary"
                  size="sm"
                  className="flex-1"
                  disabled={actionLoading === request.id}
                >
                  Remind
                </Button>
                <Button
                  onClick={() => handleCancel(request)}
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  disabled={actionLoading === request.id}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {completed.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-500 mb-2">Completed</h3>
          {completed.map((request) => (
            <div key={request.id} className="bg-white rounded-lg shadow-sm p-4 mb-3 opacity-75">
              <div className="flex items-start gap-3">
                <Avatar src={request.requestee_avatar} name={request.requestee_name || ''} />
                <div className="flex-1">
                  <p className="font-medium">{request.requestee_name}</p>
                  {request.note && <p className="text-gray-700 mt-1">{request.note}</p>}
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold">{formatCurrency(request.amount)}</p>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    request.status === 'paid' ? 'bg-green-100 text-green-700' :
                    request.status === 'declined' ? 'bg-red-100 text-red-700' :
                    'bg-gray-100 text-gray-700'
                  }`}>
                    {request.status}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {requests.length === 0 && (
        <div className="bg-white rounded-lg shadow-sm p-8 text-center">
          <p className="text-gray-500">No sent requests</p>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/request')({
  component: RequestPage,
});
