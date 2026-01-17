import { createFileRoute, redirect } from '@tanstack/react-router';
import { useAuthStore, useStoreStore } from '../stores/auth';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const { user, checkAuth } = useAuthStore.getState();
    if (!user) {
      await checkAuth();
    }
  },
  component: HomePage,
});

function HomePage() {
  const { user, isLoading: authLoading, logout } = useAuthStore();
  const { stores, fetchStores, isLoading: storesLoading, createStore } = useStoreStore();
  const navigate = useNavigate();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newStore, setNewStore] = useState({ name: '', subdomain: '', description: '' });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (user) {
      fetchStores();
    }
  }, [user, fetchStores]);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Shopify Clone</h1>
          <p className="text-gray-600 mb-8">Multi-tenant e-commerce platform</p>

          <div className="space-y-4">
            <Link
              to="/login"
              className="block w-full bg-indigo-600 text-white py-3 px-4 rounded-lg font-medium text-center hover:bg-indigo-700 transition-colors"
            >
              Sign In
            </Link>
            <Link
              to="/register"
              className="block w-full bg-white text-indigo-600 py-3 px-4 rounded-lg font-medium text-center border-2 border-indigo-600 hover:bg-indigo-50 transition-colors"
            >
              Create Account
            </Link>
          </div>

          <div className="mt-8 pt-8 border-t border-gray-200">
            <p className="text-sm text-gray-500 text-center">
              Demo credentials: merchant@example.com / merchant123
            </p>
          </div>
        </div>
      </div>
    );
  }

  const handleCreateStore = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      const store = await createStore(newStore);
      setShowCreateModal(false);
      setNewStore({ name: '', subdomain: '', description: '' });
      navigate({ to: '/admin/$storeId', params: { storeId: String(store.id) } });
    } catch {
      // Error handled by store
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
          <h1 className="text-2xl font-bold text-gray-900">Shopify Clone</h1>
          <div className="flex items-center gap-4">
            <span className="text-gray-600">{user.name}</span>
            <button
              onClick={logout}
              className="text-gray-500 hover:text-gray-700"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-8">
          <h2 className="text-xl font-semibold text-gray-900">Your Stores</h2>
          <button
            onClick={() => setShowCreateModal(true)}
            className="bg-indigo-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-indigo-700 transition-colors"
          >
            Create Store
          </button>
        </div>

        {storesLoading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
          </div>
        ) : stores.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
            <div className="text-gray-400 mb-4">
              <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">No stores yet</h3>
            <p className="text-gray-500 mb-6">Create your first store to get started</p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="bg-indigo-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-indigo-700 transition-colors"
            >
              Create Your First Store
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {stores.map((store) => (
              <div
                key={store.id}
                className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">{store.name}</h3>
                    <p className="text-sm text-gray-500">{store.subdomain}.shopify.local</p>
                  </div>
                  <span className={`px-2 py-1 text-xs rounded-full ${
                    store.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'
                  }`}>
                    {store.status}
                  </span>
                </div>
                {store.description && (
                  <p className="text-gray-600 text-sm mb-4 line-clamp-2">{store.description}</p>
                )}
                <div className="flex gap-2">
                  <Link
                    to="/admin/$storeId"
                    params={{ storeId: String(store.id) }}
                    className="flex-1 bg-indigo-600 text-white py-2 px-4 rounded-lg text-center font-medium hover:bg-indigo-700 transition-colors text-sm"
                  >
                    Manage
                  </Link>
                  <Link
                    to="/store/$subdomain"
                    params={{ subdomain: store.subdomain }}
                    className="flex-1 bg-white text-indigo-600 py-2 px-4 rounded-lg text-center font-medium border border-indigo-600 hover:bg-indigo-50 transition-colors text-sm"
                  >
                    View Store
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6">
            <h3 className="text-xl font-semibold text-gray-900 mb-6">Create New Store</h3>
            <form onSubmit={handleCreateStore} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Store Name</label>
                <input
                  type="text"
                  value={newStore.name}
                  onChange={(e) => setNewStore({ ...newStore, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  placeholder="My Awesome Store"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Subdomain</label>
                <div className="flex">
                  <input
                    type="text"
                    value={newStore.subdomain}
                    onChange={(e) => setNewStore({ ...newStore, subdomain: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-l-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    placeholder="my-store"
                    required
                  />
                  <span className="px-3 py-2 bg-gray-100 border border-l-0 border-gray-300 rounded-r-lg text-gray-500 text-sm">
                    .shopify.local
                  </span>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
                <textarea
                  value={newStore.description}
                  onChange={(e) => setNewStore({ ...newStore, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  rows={3}
                  placeholder="Describe your store..."
                />
              </div>
              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 py-2 px-4 border border-gray-300 rounded-lg font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="flex-1 py-2 px-4 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50"
                >
                  {creating ? 'Creating...' : 'Create Store'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
