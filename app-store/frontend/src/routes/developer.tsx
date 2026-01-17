import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import type { App } from '../types';
import api from '../services/api';

export const Route = createFileRoute('/developer')({
  component: DeveloperDashboard,
});

function DeveloperDashboard() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [apps, setApps] = useState<App[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    if (!user) {
      navigate({ to: '/login' });
      return;
    }

    if (user.role !== 'developer' && user.role !== 'admin') {
      navigate({ to: '/' });
      return;
    }

    fetchApps();
  }, [user, navigate]);

  const fetchApps = async () => {
    try {
      const response = await api.get<{ data: App[] }>('/developer/apps');
      setApps(response.data);
    } catch (error) {
      console.error('Failed to fetch apps:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const getStatusBadge = (status: App['status']) => {
    const styles: Record<string, string> = {
      draft: 'bg-gray-100 text-gray-700',
      pending: 'bg-yellow-100 text-yellow-700',
      approved: 'bg-green-100 text-green-700',
      rejected: 'bg-red-100 text-red-700',
      published: 'bg-blue-100 text-blue-700',
      suspended: 'bg-red-100 text-red-700',
    };
    return styles[status] || 'bg-gray-100 text-gray-700';
  };

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-8" />
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 bg-gray-200 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Developer Dashboard</h1>
          <p className="text-gray-500">Manage your apps and track performance</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="btn btn-primary"
        >
          <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New App
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-6 mb-8">
        <div className="card p-6">
          <p className="text-sm text-gray-500 mb-1">Total Apps</p>
          <p className="text-3xl font-bold text-gray-900">{apps.length}</p>
        </div>
        <div className="card p-6">
          <p className="text-sm text-gray-500 mb-1">Published</p>
          <p className="text-3xl font-bold text-green-600">
            {apps.filter((a) => a.status === 'published').length}
          </p>
        </div>
        <div className="card p-6">
          <p className="text-sm text-gray-500 mb-1">Total Downloads</p>
          <p className="text-3xl font-bold text-blue-600">
            {apps.reduce((sum, a) => sum + a.downloadCount, 0).toLocaleString()}
          </p>
        </div>
        <div className="card p-6">
          <p className="text-sm text-gray-500 mb-1">Avg Rating</p>
          <p className="text-3xl font-bold text-yellow-600">
            {apps.length > 0
              ? (apps.reduce((sum, a) => sum + a.averageRating, 0) / apps.length).toFixed(1)
              : '0.0'}
          </p>
        </div>
      </div>

      {/* Apps List */}
      <div className="card">
        <div className="p-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">Your Apps</h2>
        </div>

        {apps.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-gray-500 mb-4">You haven't created any apps yet</p>
            <button onClick={() => setShowCreateModal(true)} className="btn btn-primary">
              Create Your First App
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {apps.map((app) => (
              <div key={app.id} className="p-4 hover:bg-gray-50">
                <div className="flex items-center gap-4">
                  {app.iconUrl ? (
                    <img src={app.iconUrl} alt={app.name} className="w-16 h-16 app-icon object-cover" />
                  ) : (
                    <div className="w-16 h-16 app-icon bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center text-white font-bold text-xl">
                      {app.name.charAt(0)}
                    </div>
                  )}

                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold text-gray-900">{app.name}</h3>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getStatusBadge(app.status)}`}>
                        {app.status}
                      </span>
                    </div>
                    <p className="text-sm text-gray-500">{app.bundleId}</p>
                    <div className="flex items-center gap-4 mt-1 text-sm text-gray-400">
                      <span>{app.downloadCount.toLocaleString()} downloads</span>
                      <span>{app.averageRating.toFixed(1)} rating</span>
                      <span>v{app.version || '1.0'}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Link
                      to="/developer/app/$id"
                      params={{ id: app.id }}
                      className="btn btn-outline text-sm"
                    >
                      Manage
                    </Link>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create App Modal */}
      {showCreateModal && (
        <CreateAppModal
          onClose={() => setShowCreateModal(false)}
          onCreated={(app) => {
            setApps([app, ...apps]);
            setShowCreateModal(false);
          }}
        />
      )}
    </div>
  );
}

function CreateAppModal({ onClose, onCreated }: { onClose: () => void; onCreated: (app: App) => void }) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({
    bundleId: '',
    name: '',
    description: '',
    shortDescription: '',
    isFree: true,
    price: 0,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const response = await api.post<{ data: App }>('/developer/apps', formData);
      onCreated(response.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create app');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-gray-100">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold text-gray-900">Create New App</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm">{error}</div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Bundle ID</label>
            <input
              type="text"
              value={formData.bundleId}
              onChange={(e) => setFormData({ ...formData, bundleId: e.target.value })}
              className="input"
              placeholder="com.example.myapp"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">App Name</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="input"
              placeholder="My Awesome App"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Short Description</label>
            <input
              type="text"
              value={formData.shortDescription}
              onChange={(e) => setFormData({ ...formData, shortDescription: e.target.value })}
              className="input"
              placeholder="A brief tagline for your app"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="input min-h-[100px]"
              placeholder="Describe what your app does..."
              required
            />
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={formData.isFree}
                onChange={(e) => setFormData({ ...formData, isFree: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-sm text-gray-700">Free app</span>
            </label>

            {!formData.isFree && (
              <div className="flex-1">
                <input
                  type="number"
                  step="0.01"
                  min="0.99"
                  value={formData.price}
                  onChange={(e) => setFormData({ ...formData, price: parseFloat(e.target.value) })}
                  className="input"
                  placeholder="Price"
                />
              </div>
            )}
          </div>

          <div className="flex gap-3 pt-4">
            <button type="button" onClick={onClose} className="btn btn-secondary flex-1">
              Cancel
            </button>
            <button type="submit" disabled={isLoading} className="btn btn-primary flex-1">
              {isLoading ? 'Creating...' : 'Create App'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
