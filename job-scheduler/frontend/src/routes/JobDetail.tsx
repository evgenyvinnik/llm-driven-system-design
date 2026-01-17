/**
 * Job detail page showing full job configuration and execution history.
 * Provides job lifecycle actions and paginated execution list.
 * @module routes/JobDetail
 */

import { useEffect } from 'react';
import { useParams, Link } from '@tanstack/react-router';
import { useJobsStore, useExecutionsStore } from '../stores';
import { Button, Spinner, StatusBadge, Pagination } from '../components/UI';
import { ExecutionList } from '../components/ExecutionList';
import { JobStatus } from '../types';

/**
 * Detailed view of a single job with metadata and executions.
 * Shows job configuration, payload, and full execution history.
 */
export function JobDetailPage() {
  const { jobId } = useParams({ from: '/jobs/$jobId' });
  const { selectedJob, loading: jobLoading, fetchJob, pauseJob, resumeJob, triggerJob, deleteJob } = useJobsStore();
  const {
    executions,
    loading: executionsLoading,
    page,
    totalPages,
    fetchExecutions,
    cancelExecution,
    retryExecution,
  } = useExecutionsStore();

  useEffect(() => {
    fetchJob(jobId);
    fetchExecutions(jobId, 1);
  }, [jobId, fetchJob, fetchExecutions]);

  const handlePageChange = (newPage: number) => {
    fetchExecutions(jobId, newPage);
  };

  if (jobLoading || !selectedJob) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-4">
        <Link to="/jobs" className="text-blue-600 hover:text-blue-800">
          Jobs
        </Link>
        <span className="text-gray-400">/</span>
        <span className="text-gray-900 font-medium">{selectedJob.name}</span>
      </div>

      {/* Job Details */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{selectedJob.name}</h1>
              <p className="text-gray-500 mt-1">
                {selectedJob.description || 'No description'}
              </p>
            </div>
            <StatusBadge status={selectedJob.status} />
          </div>

          <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <dt className="text-sm text-gray-500">Handler</dt>
              <dd className="text-sm font-mono text-gray-900">{selectedJob.handler}</dd>
            </div>
            <div>
              <dt className="text-sm text-gray-500">Priority</dt>
              <dd className="text-sm text-gray-900">{selectedJob.priority}</dd>
            </div>
            <div>
              <dt className="text-sm text-gray-500">Schedule</dt>
              <dd className="text-sm font-mono text-gray-900">
                {selectedJob.schedule || 'One-time'}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-gray-500">Next Run</dt>
              <dd className="text-sm text-gray-900">
                {selectedJob.next_run_time
                  ? new Date(selectedJob.next_run_time).toLocaleString()
                  : '-'}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-gray-500">Max Retries</dt>
              <dd className="text-sm text-gray-900">{selectedJob.max_retries}</dd>
            </div>
            <div>
              <dt className="text-sm text-gray-500">Timeout</dt>
              <dd className="text-sm text-gray-900">{selectedJob.timeout_ms}ms</dd>
            </div>
            <div>
              <dt className="text-sm text-gray-500">Created</dt>
              <dd className="text-sm text-gray-900">
                {new Date(selectedJob.created_at).toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-gray-500">Updated</dt>
              <dd className="text-sm text-gray-900">
                {new Date(selectedJob.updated_at).toLocaleString()}
              </dd>
            </div>
          </dl>

          {selectedJob.payload && Object.keys(selectedJob.payload).length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-medium text-gray-900 mb-2">Payload</h3>
              <pre className="bg-gray-50 p-4 rounded-md text-sm text-gray-800 overflow-x-auto">
                {JSON.stringify(selectedJob.payload, null, 2)}
              </pre>
            </div>
          )}

          <div className="mt-6 flex space-x-2">
            {selectedJob.status === JobStatus.PAUSED ? (
              <Button variant="success" onClick={() => resumeJob(jobId)}>
                Resume
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => pauseJob(jobId)}>
                Pause
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() => triggerJob(jobId)}
              disabled={selectedJob.status === JobStatus.PAUSED}
            >
              Trigger Now
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (window.confirm('Are you sure you want to delete this job?')) {
                  deleteJob(jobId);
                  window.history.back();
                }
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </div>

      {/* Executions */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 border-b border-gray-200 sm:px-6">
          <h2 className="text-lg font-medium text-gray-900">Executions</h2>
        </div>
        <div className="p-4">
          {executionsLoading ? (
            <Spinner />
          ) : (
            <>
              <ExecutionList
                executions={executions}
                onCancel={cancelExecution}
                onRetry={retryExecution}
              />
              <Pagination
                page={page}
                totalPages={totalPages}
                onPageChange={handlePageChange}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
