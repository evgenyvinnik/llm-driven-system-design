/**
 * Jobs list page with CRUD operations.
 * Provides paginated job listing with create, pause, resume, trigger, and delete actions.
 * @module routes/Jobs
 */

import { useEffect, useState } from 'react';
import { useJobsStore } from '../stores';
import { Button, Spinner, Pagination } from '../components/UI';
import { JobTable } from '../components/JobCard';
import { CreateJobModal } from '../components/CreateJobModal';

/**
 * Jobs management page with table view and pagination.
 * Includes modal for creating new jobs.
 */
export function JobsPage() {
  const {
    jobs,
    loading,
    page,
    totalPages,
    fetchJobs,
    createJob,
    pauseJob,
    resumeJob,
    triggerJob,
    deleteJob,
  } = useJobsStore();

  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    fetchJobs(1);
  }, [fetchJobs]);

  const handlePageChange = (newPage: number) => {
    fetchJobs(newPage);
  };

  const handleCreate = async (input: Parameters<typeof createJob>[0]) => {
    await createJob(input);
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this job?')) {
      await deleteJob(id);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Jobs</h1>
        <Button onClick={() => setShowCreateModal(true)}>Create Job</Button>
      </div>

      {loading && jobs.length === 0 ? (
        <div className="flex justify-center items-center h-64">
          <Spinner size="lg" />
        </div>
      ) : jobs.length > 0 ? (
        <>
          <JobTable
            jobs={jobs}
            onPause={pauseJob}
            onResume={resumeJob}
            onTrigger={triggerJob}
            onDelete={handleDelete}
          />
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={handlePageChange}
          />
        </>
      ) : (
        <div className="text-center py-12 bg-white shadow rounded-lg">
          <h3 className="text-lg font-medium text-gray-900 mb-2">No jobs yet</h3>
          <p className="text-gray-500 mb-4">
            Create your first job to get started with the scheduler.
          </p>
          <Button onClick={() => setShowCreateModal(true)}>Create Job</Button>
        </div>
      )}

      <CreateJobModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreate={handleCreate}
      />
    </div>
  );
}
