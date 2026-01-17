import { SubmissionStatus } from '../types';

interface StatusBadgeProps {
  status: SubmissionStatus | string;
}

const statusConfig: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'text-gray-400 bg-gray-400/10' },
  running: { label: 'Running', className: 'text-yellow-400 bg-yellow-400/10' },
  accepted: { label: 'Accepted', className: 'text-green-400 bg-green-400/10' },
  wrong_answer: { label: 'Wrong Answer', className: 'text-red-400 bg-red-400/10' },
  time_limit_exceeded: { label: 'Time Limit Exceeded', className: 'text-orange-400 bg-orange-400/10' },
  memory_limit_exceeded: { label: 'Memory Limit Exceeded', className: 'text-orange-400 bg-orange-400/10' },
  runtime_error: { label: 'Runtime Error', className: 'text-red-500 bg-red-500/10' },
  compile_error: { label: 'Compile Error', className: 'text-red-500 bg-red-500/10' },
  system_error: { label: 'System Error', className: 'text-gray-500 bg-gray-500/10' },
  success: { label: 'Success', className: 'text-green-400 bg-green-400/10' },
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = statusConfig[status] || { label: status, className: 'text-gray-400 bg-gray-400/10' };

  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${config.className}`}>
      {config.label}
    </span>
  );
}
