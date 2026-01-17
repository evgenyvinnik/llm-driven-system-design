import { useEffect } from 'react';
import { useParams, Link } from '@tanstack/react-router';
import { useExecutionsStore } from '../stores';
import { Spinner } from '../components/UI';
import { ExecutionDetail } from '../components/ExecutionList';

export function ExecutionDetailPage() {
  const { executionId } = useParams({ from: '/executions/$executionId' });
  const {
    selectedExecution,
    loading,
    fetchExecution,
    cancelExecution,
    retryExecution,
  } = useExecutionsStore();

  useEffect(() => {
    fetchExecution(executionId);

    // Auto-refresh for running executions
    const interval = setInterval(() => {
      if (selectedExecution?.status === 'RUNNING' || selectedExecution?.status === 'PENDING') {
        fetchExecution(executionId);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [executionId, fetchExecution, selectedExecution?.status]);

  if (loading || !selectedExecution) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-4">
        <Link
          to="/jobs/$jobId"
          params={{ jobId: selectedExecution.job_id }}
          className="text-blue-600 hover:text-blue-800"
        >
          Job
        </Link>
        <span className="text-gray-400">/</span>
        <span className="text-gray-900 font-medium">
          Execution {selectedExecution.id.substring(0, 8)}...
        </span>
      </div>

      <ExecutionDetail
        execution={selectedExecution}
        onCancel={() => cancelExecution(executionId)}
        onRetry={() => retryExecution(executionId)}
      />
    </div>
  );
}
