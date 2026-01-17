/**
 * Dashboard page showing system overview and recent activity.
 * Displays key metrics, worker status, and recent jobs.
 * @module routes/Dashboard
 */

import { useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import { useMetricsStore, useJobsStore } from '../stores';
import { MetricCard, Spinner } from '../components/UI';
import { JobTable } from '../components/JobCard';

/**
 * Main dashboard view with system metrics and job overview.
 * Auto-refreshes metrics every 5 seconds for real-time monitoring.
 */
export function DashboardPage() {
  const { metrics, loading: metricsLoading, fetchMetrics, fetchWorkers } = useMetricsStore();
  const { jobs, loading: jobsLoading, fetchJobs, pauseJob, resumeJob, triggerJob, deleteJob } = useJobsStore();

  useEffect(() => {
    fetchMetrics();
    fetchWorkers();
    fetchJobs(1);

    // Auto-refresh every 5 seconds
    const interval = setInterval(() => {
      fetchMetrics();
      fetchWorkers();
    }, 5000);

    return () => clearInterval(interval);
  }, [fetchMetrics, fetchWorkers, fetchJobs]);

  if (metricsLoading && !metrics) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <Link
          to="/jobs"
          className="text-blue-600 hover:text-blue-800 text-sm font-medium"
        >
          View all jobs
        </Link>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Total Jobs"
          value={metrics?.jobs.total_jobs || 0}
        />
        <MetricCard
          title="Active Jobs"
          value={metrics?.jobs.active_jobs || 0}
        />
        <MetricCard
          title="Queue Depth"
          value={metrics?.queue.queued || 0}
          subtitle={`${metrics?.queue.processing || 0} processing`}
        />
        <MetricCard
          title="Active Workers"
          value={metrics?.workers.active || 0}
          subtitle={`${metrics?.workers.total || 0} total`}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Completed (24h)"
          value={metrics?.jobs.completed_24h || 0}
          trend="up"
        />
        <MetricCard
          title="Failed (24h)"
          value={metrics?.jobs.failed_24h || 0}
          trend={metrics?.jobs.failed_24h ? 'down' : 'neutral'}
        />
        <MetricCard
          title="Running Now"
          value={metrics?.jobs.running_executions || 0}
        />
        <MetricCard
          title="Dead Letter Queue"
          value={metrics?.queue.deadLetter || 0}
          trend={metrics?.queue.deadLetter ? 'down' : 'neutral'}
        />
      </div>

      {/* Recent Jobs */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 border-b border-gray-200 sm:px-6">
          <h2 className="text-lg font-medium text-gray-900">Recent Jobs</h2>
        </div>
        <div className="p-4">
          {jobsLoading ? (
            <Spinner />
          ) : jobs.length > 0 ? (
            <JobTable
              jobs={jobs.slice(0, 5)}
              onPause={pauseJob}
              onResume={resumeJob}
              onTrigger={triggerJob}
              onDelete={deleteJob}
            />
          ) : (
            <p className="text-gray-500 text-center py-8">
              No jobs found. Create your first job to get started.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
