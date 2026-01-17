import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import type { Dashboard } from '../types';
import { getDashboards, createDashboard, deleteDashboard } from '../services/api';

export const Route = createFileRoute('/')({
  component: DashboardsPage,
});

function DashboardsPage() {
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');

  const fetchDashboards = async () => {
    try {
      setLoading(true);
      const data = await getDashboards();
      setDashboards(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch dashboards');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboards();
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;

    try {
      await createDashboard({
        name: newName.trim(),
        description: newDescription.trim() || undefined,
        is_public: true,
      });
      setNewName('');
      setNewDescription('');
      setShowCreate(false);
      fetchDashboards();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create dashboard');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this dashboard?')) return;

    try {
      await deleteDashboard(id);
      fetchDashboards();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete dashboard');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-dashboard-muted">Loading dashboards...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-red-400">{error}</div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-dashboard-text">Dashboards</h1>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="bg-dashboard-highlight hover:bg-dashboard-highlight/80 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors"
        >
          {showCreate ? 'Cancel' : 'New Dashboard'}
        </button>
      </div>

      {showCreate && (
        <div className="bg-dashboard-card border border-dashboard-accent rounded-lg p-4 mb-8">
          <h2 className="text-lg font-semibold mb-4">Create New Dashboard</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-dashboard-muted mb-1">Name</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full bg-dashboard-bg border border-dashboard-accent rounded-md px-3 py-2 text-dashboard-text focus:outline-none focus:ring-2 focus:ring-dashboard-highlight"
                placeholder="Dashboard name"
              />
            </div>
            <div>
              <label className="block text-sm text-dashboard-muted mb-1">
                Description (optional)
              </label>
              <textarea
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                className="w-full bg-dashboard-bg border border-dashboard-accent rounded-md px-3 py-2 text-dashboard-text focus:outline-none focus:ring-2 focus:ring-dashboard-highlight"
                placeholder="Dashboard description"
                rows={2}
              />
            </div>
            <button
              onClick={handleCreate}
              disabled={!newName.trim()}
              className="bg-dashboard-highlight hover:bg-dashboard-highlight/80 disabled:opacity-50 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors"
            >
              Create Dashboard
            </button>
          </div>
        </div>
      )}

      {dashboards.length === 0 ? (
        <div className="bg-dashboard-card border border-dashboard-accent rounded-lg p-8 text-center">
          <p className="text-dashboard-muted mb-4">No dashboards found</p>
          <button
            onClick={() => setShowCreate(true)}
            className="text-dashboard-highlight hover:underline"
          >
            Create your first dashboard
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {dashboards.map((dashboard) => (
            <div
              key={dashboard.id}
              className="bg-dashboard-card border border-dashboard-accent rounded-lg p-4 hover:border-dashboard-highlight transition-colors"
            >
              <Link
                to="/dashboard/$dashboardId"
                params={{ dashboardId: dashboard.id }}
                className="block"
              >
                <h3 className="text-lg font-semibold text-dashboard-text mb-2">
                  {dashboard.name}
                </h3>
                {dashboard.description && (
                  <p className="text-sm text-dashboard-muted mb-4">{dashboard.description}</p>
                )}
                <div className="flex items-center justify-between text-xs text-dashboard-muted">
                  <span>
                    {dashboard.panels?.length || 0} panel(s)
                  </span>
                  <span>{dashboard.is_public ? 'Public' : 'Private'}</span>
                </div>
              </Link>
              <div className="mt-4 pt-4 border-t border-dashboard-accent flex justify-end">
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    handleDelete(dashboard.id);
                  }}
                  className="text-red-400 hover:text-red-300 text-sm"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
