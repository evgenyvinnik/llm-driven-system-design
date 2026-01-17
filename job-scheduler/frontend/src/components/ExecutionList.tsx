/**
 * Execution display components for monitoring job runs.
 * Provides list view and detailed execution information with logs.
 * @module components/ExecutionList
 */

import { Link } from '@tanstack/react-router';
import { JobExecution, ExecutionStatus } from '../types';
import { StatusBadge, Button } from './UI';

/** Props for the ExecutionList component */
interface ExecutionListProps {
  /** Array of executions to display */
  executions: JobExecution[];
  /** Whether to show links to parent jobs */
  showJobLink?: boolean;
  /** Callback to cancel a running execution */
  onCancel?: (id: string) => void;
  /** Callback to retry a failed execution */
  onRetry?: (id: string) => void;
}

/**
 * Table view of job executions with status and actions.
 * Shows execution ID, status, timing, and worker information.
 */
export function ExecutionList({ executions, showJobLink, onCancel, onRetry }: ExecutionListProps) {
  if (executions.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        No executions found
      </div>
    );
  }

  return (
    <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 rounded-lg">
      <table className="min-w-full divide-y divide-gray-300">
        <thead className="bg-gray-50">
          <tr>
            <th className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900">
              ID
            </th>
            {showJobLink && (
              <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                Job
              </th>
            )}
            <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
              Status
            </th>
            <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
              Attempt
            </th>
            <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
              Scheduled
            </th>
            <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
              Duration
            </th>
            <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
              Worker
            </th>
            <th className="relative py-3.5 pl-3 pr-4">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 bg-white">
          {executions.map((execution) => {
            const duration =
              execution.started_at && execution.completed_at
                ? new Date(execution.completed_at).getTime() -
                  new Date(execution.started_at).getTime()
                : null;

            return (
              <tr key={execution.id}>
                <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm">
                  <Link
                    to="/executions/$executionId"
                    params={{ executionId: execution.id }}
                    className="font-mono text-blue-600 hover:text-blue-800"
                  >
                    {execution.id.substring(0, 8)}...
                  </Link>
                </td>
                {showJobLink && (
                  <td className="whitespace-nowrap px-3 py-4 text-sm">
                    <Link
                      to="/jobs/$jobId"
                      params={{ jobId: execution.job_id }}
                      className="text-blue-600 hover:text-blue-800"
                    >
                      {execution.job_id.substring(0, 8)}...
                    </Link>
                  </td>
                )}
                <td className="whitespace-nowrap px-3 py-4 text-sm">
                  <StatusBadge status={execution.status} size="sm" />
                </td>
                <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-900">
                  {execution.attempt}
                </td>
                <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-900">
                  {new Date(execution.scheduled_at).toLocaleString()}
                </td>
                <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-900">
                  {duration !== null ? `${duration}ms` : '-'}
                </td>
                <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                  {execution.worker_id || '-'}
                </td>
                <td className="relative whitespace-nowrap py-4 pl-3 pr-4 text-right text-sm font-medium space-x-2">
                  {(execution.status === ExecutionStatus.PENDING ||
                    execution.status === ExecutionStatus.RUNNING) && (
                    <button
                      onClick={() => onCancel?.(execution.id)}
                      className="text-red-600 hover:text-red-900"
                    >
                      Cancel
                    </button>
                  )}
                  {(execution.status === ExecutionStatus.FAILED ||
                    execution.status === ExecutionStatus.CANCELLED) && (
                    <button
                      onClick={() => onRetry?.(execution.id)}
                      className="text-blue-600 hover:text-blue-900"
                    >
                      Retry
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Props for the ExecutionDetail component */
interface ExecutionDetailProps {
  /** Execution data including logs and result */
  execution: JobExecution;
  /** Callback to cancel this execution */
  onCancel?: () => void;
  /** Callback to retry this execution */
  onRetry?: () => void;
}

/**
 * Detailed view of a single execution.
 * Shows full timing, worker, error/result data, and execution logs.
 */
export function ExecutionDetail({ execution, onCancel, onRetry }: ExecutionDetailProps) {
  const duration =
    execution.started_at && execution.completed_at
      ? new Date(execution.completed_at).getTime() -
        new Date(execution.started_at).getTime()
      : null;

  return (
    <div className="bg-white shadow rounded-lg">
      <div className="px-4 py-5 sm:p-6">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h2 className="text-lg font-medium text-gray-900">
              Execution {execution.id.substring(0, 8)}...
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              Job: {execution.job_id}
            </p>
          </div>
          <StatusBadge status={execution.status} />
        </div>

        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-gray-500">Attempt</dt>
            <dd className="text-gray-900">{execution.attempt}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Worker</dt>
            <dd className="text-gray-900">{execution.worker_id || '-'}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Scheduled At</dt>
            <dd className="text-gray-900">
              {new Date(execution.scheduled_at).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Started At</dt>
            <dd className="text-gray-900">
              {execution.started_at
                ? new Date(execution.started_at).toLocaleString()
                : '-'}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Completed At</dt>
            <dd className="text-gray-900">
              {execution.completed_at
                ? new Date(execution.completed_at).toLocaleString()
                : '-'}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Duration</dt>
            <dd className="text-gray-900">
              {duration !== null ? `${duration}ms` : '-'}
            </dd>
          </div>
        </dl>

        {execution.error && (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-red-600 mb-2">Error</h3>
            <pre className="bg-red-50 p-4 rounded-md text-sm text-red-800 overflow-x-auto">
              {execution.error}
            </pre>
          </div>
        )}

        {execution.result && (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-gray-900 mb-2">Result</h3>
            <pre className="bg-gray-50 p-4 rounded-md text-sm text-gray-800 overflow-x-auto">
              {JSON.stringify(execution.result, null, 2)}
            </pre>
          </div>
        )}

        {execution.logs && execution.logs.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-gray-900 mb-2">Logs</h3>
            <div className="bg-gray-900 rounded-md p-4 overflow-x-auto">
              {execution.logs.map((log) => (
                <div key={log.id} className="font-mono text-sm">
                  <span className="text-gray-500">
                    {new Date(log.created_at).toLocaleTimeString()}
                  </span>{' '}
                  <span
                    className={
                      log.level === 'error'
                        ? 'text-red-400'
                        : log.level === 'warn'
                        ? 'text-yellow-400'
                        : 'text-green-400'
                    }
                  >
                    [{log.level.toUpperCase()}]
                  </span>{' '}
                  <span className="text-white">{log.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 flex space-x-2">
          {(execution.status === ExecutionStatus.PENDING ||
            execution.status === ExecutionStatus.RUNNING) && (
            <Button variant="danger" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {(execution.status === ExecutionStatus.FAILED ||
            execution.status === ExecutionStatus.CANCELLED) && (
            <Button variant="primary" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
