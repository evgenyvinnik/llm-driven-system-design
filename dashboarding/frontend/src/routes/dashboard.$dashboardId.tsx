import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import type { Dashboard, TimeRange } from '../types';
import { getDashboard } from '../services/api';
import { DashboardGrid } from '../components/DashboardGrid';
import { TimeRangeSelector } from '../components/TimeRangeSelector';

export const Route = createFileRoute('/dashboard/$dashboardId')({
  component: DashboardViewPage,
});

function DashboardViewPage() {
  const { dashboardId } = Route.useParams();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>('1h');
  const [lastRefresh, setLastRefresh] = useState(new Date());

  const fetchDashboard = async () => {
    try {
      setLoading(true);
      const data = await getDashboard(dashboardId);
      setDashboard(data);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch dashboard');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboard();
  }, [dashboardId]);

  const handleRefresh = () => {
    fetchDashboard();
  };

  if (loading && !dashboard) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-dashboard-muted">Loading dashboard...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <div className="text-red-400">{error}</div>
        <Link to="/" className="text-dashboard-highlight hover:underline">
          Back to dashboards
        </Link>
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <div className="text-dashboard-muted">Dashboard not found</div>
        <Link to="/" className="text-dashboard-highlight hover:underline">
          Back to dashboards
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-dashboard-bg">
      <div className="border-b border-dashboard-accent bg-dashboard-card">
        <div className="max-w-full mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link
                to="/"
                className="text-dashboard-muted hover:text-dashboard-text"
              >
                &larr;
              </Link>
              <div>
                <h1 className="text-xl font-bold text-dashboard-text">
                  {dashboard.name}
                </h1>
                {dashboard.description && (
                  <p className="text-sm text-dashboard-muted">
                    {dashboard.description}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-4">
              <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
              <button
                onClick={handleRefresh}
                className="bg-dashboard-accent hover:bg-dashboard-accent/80 text-dashboard-text px-3 py-2 rounded-md text-sm font-medium transition-colors"
              >
                Refresh
              </button>
              <span className="text-xs text-dashboard-muted">
                Updated: {lastRefresh.toLocaleTimeString()}
              </span>
            </div>
          </div>
        </div>
      </div>

      {dashboard.panels && dashboard.panels.length > 0 ? (
        <DashboardGrid
          panels={dashboard.panels}
          dashboardId={dashboard.id}
          timeRange={timeRange}
          columns={dashboard.layout?.columns || 12}
        />
      ) : (
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <div className="text-dashboard-muted">No panels in this dashboard</div>
          <p className="text-sm text-dashboard-muted">
            Add panels via the API or seed data
          </p>
        </div>
      )}
    </div>
  );
}
