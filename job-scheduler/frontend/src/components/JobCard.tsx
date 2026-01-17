import { Link } from '@tanstack/react-router';
import { Job, JobWithStats, JobStatus } from '../types';
import { StatusBadge, Button } from './UI';

interface JobCardProps {
  job: Job | JobWithStats;
  onPause?: (id: string) => void;
  onResume?: (id: string) => void;
  onTrigger?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export function JobCard({ job, onPause, onResume, onTrigger, onDelete }: JobCardProps) {
  const stats = 'total_executions' in job ? job : null;

  return (
    <div className="bg-white shadow rounded-lg p-4">
      <div className="flex justify-between items-start">
        <div className="flex-1">
          <Link
            to="/jobs/$jobId"
            params={{ jobId: job.id }}
            className="text-lg font-medium text-blue-600 hover:text-blue-800"
          >
            {job.name}
          </Link>
          <p className="text-sm text-gray-500 mt-1">{job.description || 'No description'}</p>
        </div>
        <StatusBadge status={job.status} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-gray-500">Handler:</span>{' '}
          <span className="font-mono text-gray-900">{job.handler}</span>
        </div>
        <div>
          <span className="text-gray-500">Priority:</span>{' '}
          <span className="text-gray-900">{job.priority}</span>
        </div>
        {job.schedule && (
          <div>
            <span className="text-gray-500">Schedule:</span>{' '}
            <span className="font-mono text-gray-900">{job.schedule}</span>
          </div>
        )}
        {job.next_run_time && (
          <div>
            <span className="text-gray-500">Next run:</span>{' '}
            <span className="text-gray-900">
              {new Date(job.next_run_time).toLocaleString()}
            </span>
          </div>
        )}
      </div>

      {stats && (
        <div className="mt-4 flex space-x-4 text-sm">
          <span className="text-gray-500">
            Total: <span className="text-gray-900">{stats.total_executions}</span>
          </span>
          <span className="text-green-600">
            Success: {stats.successful_executions}
          </span>
          <span className="text-red-600">
            Failed: {stats.failed_executions}
          </span>
          {stats.avg_duration_ms && (
            <span className="text-gray-500">
              Avg: {Math.round(stats.avg_duration_ms)}ms
            </span>
          )}
        </div>
      )}

      <div className="mt-4 flex space-x-2">
        {job.status === JobStatus.PAUSED ? (
          <Button size="sm" variant="success" onClick={() => onResume?.(job.id)}>
            Resume
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => onPause?.(job.id)}>
            Pause
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          onClick={() => onTrigger?.(job.id)}
          disabled={job.status === JobStatus.PAUSED}
        >
          Trigger Now
        </Button>
        <Button size="sm" variant="danger" onClick={() => onDelete?.(job.id)}>
          Delete
        </Button>
      </div>
    </div>
  );
}

interface JobTableProps {
  jobs: (Job | JobWithStats)[];
  onPause?: (id: string) => void;
  onResume?: (id: string) => void;
  onTrigger?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export function JobTable({ jobs, onPause, onResume, onTrigger, onDelete }: JobTableProps) {
  return (
    <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 rounded-lg">
      <table className="min-w-full divide-y divide-gray-300">
        <thead className="bg-gray-50">
          <tr>
            <th className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900">
              Name
            </th>
            <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
              Handler
            </th>
            <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
              Schedule
            </th>
            <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
              Status
            </th>
            <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
              Priority
            </th>
            <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
              Stats
            </th>
            <th className="relative py-3.5 pl-3 pr-4">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 bg-white">
          {jobs.map((job) => {
            const stats = 'total_executions' in job ? job : null;
            return (
              <tr key={job.id}>
                <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm">
                  <Link
                    to="/jobs/$jobId"
                    params={{ jobId: job.id }}
                    className="font-medium text-blue-600 hover:text-blue-800"
                  >
                    {job.name}
                  </Link>
                  {job.description && (
                    <p className="text-gray-500 truncate max-w-xs">{job.description}</p>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-4 text-sm font-mono text-gray-900">
                  {job.handler}
                </td>
                <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-900">
                  {job.schedule || '-'}
                </td>
                <td className="whitespace-nowrap px-3 py-4 text-sm">
                  <StatusBadge status={job.status} size="sm" />
                </td>
                <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-900">
                  {job.priority}
                </td>
                <td className="whitespace-nowrap px-3 py-4 text-sm">
                  {stats ? (
                    <span>
                      <span className="text-green-600">{stats.successful_executions}</span>
                      {' / '}
                      <span className="text-red-600">{stats.failed_executions}</span>
                    </span>
                  ) : (
                    '-'
                  )}
                </td>
                <td className="relative whitespace-nowrap py-4 pl-3 pr-4 text-right text-sm font-medium space-x-2">
                  {job.status === JobStatus.PAUSED ? (
                    <button
                      onClick={() => onResume?.(job.id)}
                      className="text-green-600 hover:text-green-900"
                    >
                      Resume
                    </button>
                  ) : (
                    <button
                      onClick={() => onPause?.(job.id)}
                      className="text-gray-600 hover:text-gray-900"
                    >
                      Pause
                    </button>
                  )}
                  <button
                    onClick={() => onTrigger?.(job.id)}
                    className="text-blue-600 hover:text-blue-900"
                    disabled={job.status === JobStatus.PAUSED}
                  >
                    Trigger
                  </button>
                  <button
                    onClick={() => onDelete?.(job.id)}
                    className="text-red-600 hover:text-red-900"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
