import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { connectionsApi } from '../services/api';
import type { User, ConnectionRequest, PYMKCandidate } from '../types';
import { ConnectionCard } from '../components/ConnectionCard';
import { UserPlus, Users, Check, X } from 'lucide-react';

export const Route = createFileRoute('/network')({
  component: NetworkPage,
});

function NetworkPage() {
  const { isAuthenticated } = useAuthStore();
  const navigate = useNavigate();

  const [connections, setConnections] = useState<User[]>([]);
  const [pendingRequests, setPendingRequests] = useState<ConnectionRequest[]>([]);
  const [pymk, setPymk] = useState<PYMKCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'connections' | 'requests' | 'pymk'>('connections');

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }

    const loadData = async () => {
      try {
        const [connectionsData, requestsData, pymkData] = await Promise.all([
          connectionsApi.getConnections(),
          connectionsApi.getPendingRequests(),
          connectionsApi.getPYMK(20),
        ]);
        setConnections(connectionsData.connections);
        setPendingRequests(requestsData.requests);
        setPymk(pymkData.people);
      } catch (error) {
        console.error('Failed to load network data:', error);
      }
      setLoading(false);
    };

    loadData();
  }, [isAuthenticated, navigate]);

  const handleAcceptRequest = async (requestId: number) => {
    try {
      await connectionsApi.acceptRequest(requestId);
      const request = pendingRequests.find((r) => r.id === requestId);
      if (request?.from_user) {
        setConnections([...connections, request.from_user]);
      }
      setPendingRequests(pendingRequests.filter((r) => r.id !== requestId));
    } catch (error) {
      console.error('Failed to accept request:', error);
    }
  };

  const handleRejectRequest = async (requestId: number) => {
    try {
      await connectionsApi.rejectRequest(requestId);
      setPendingRequests(pendingRequests.filter((r) => r.id !== requestId));
    } catch (error) {
      console.error('Failed to reject request:', error);
    }
  };

  const handleRemoveConnection = async (userId: number) => {
    setConnections(connections.filter((c) => c.id !== userId));
  };

  if (!isAuthenticated) return null;

  if (loading) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-6">
        <div className="card p-8 text-center text-gray-500">Loading network...</div>
      </main>
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-4 py-6">
      <div className="card">
        <div className="p-4 border-b">
          <h1 className="text-xl font-semibold">Manage my network</h1>
        </div>

        {/* Tabs */}
        <div className="flex border-b">
          <button
            onClick={() => setActiveTab('connections')}
            className={`flex items-center gap-2 px-6 py-4 font-medium ${
              activeTab === 'connections'
                ? 'text-linkedin-blue border-b-2 border-linkedin-blue'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <Users className="w-5 h-5" />
            Connections ({connections.length})
          </button>
          <button
            onClick={() => setActiveTab('requests')}
            className={`flex items-center gap-2 px-6 py-4 font-medium ${
              activeTab === 'requests'
                ? 'text-linkedin-blue border-b-2 border-linkedin-blue'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <UserPlus className="w-5 h-5" />
            Requests ({pendingRequests.length})
            {pendingRequests.length > 0 && (
              <span className="bg-red-500 text-white text-xs rounded-full px-2 py-0.5">
                {pendingRequests.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('pymk')}
            className={`flex items-center gap-2 px-6 py-4 font-medium ${
              activeTab === 'pymk'
                ? 'text-linkedin-blue border-b-2 border-linkedin-blue'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            People you may know
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {activeTab === 'connections' && (
            <>
              {connections.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <Users className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                  <p>You don't have any connections yet</p>
                  <p className="text-sm mt-2">
                    Start building your network by connecting with people you know
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {connections.map((user) => (
                    <ConnectionCard
                      key={user.id}
                      user={user}
                      showRemoveButton
                      onRemove={() => handleRemoveConnection(user.id)}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {activeTab === 'requests' && (
            <>
              {pendingRequests.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <UserPlus className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                  <p>No pending connection requests</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {pendingRequests.map((request) => (
                    <div
                      key={request.id}
                      className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg"
                    >
                      <div className="w-16 h-16 rounded-full bg-gray-300 flex items-center justify-center text-xl font-bold flex-shrink-0">
                        {request.from_user?.first_name?.[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold">
                          {request.from_user?.first_name} {request.from_user?.last_name}
                        </div>
                        <div className="text-sm text-gray-600 truncate">
                          {request.from_user?.headline}
                        </div>
                        {request.message && (
                          <div className="text-sm text-gray-500 mt-1 italic">
                            "{request.message}"
                          </div>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleAcceptRequest(request.id)}
                          className="btn-primary flex items-center gap-1"
                        >
                          <Check className="w-4 h-4" />
                          Accept
                        </button>
                        <button
                          onClick={() => handleRejectRequest(request.id)}
                          className="btn-secondary flex items-center gap-1"
                        >
                          <X className="w-4 h-4" />
                          Ignore
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {activeTab === 'pymk' && (
            <>
              {pymk.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <Users className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                  <p>No suggestions at the moment</p>
                  <p className="text-sm mt-2">
                    We'll show you people you may know as you build your network
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {pymk.map((candidate) => (
                    <ConnectionCard
                      key={candidate.user.id}
                      user={candidate.user}
                      pymkData={candidate}
                      showConnectButton
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
