import { createFileRoute } from '@tanstack/react-router';
import { useProjectStore } from '../../../stores';
import { Spinner } from '../../../components/ui';

export const Route = createFileRoute('/projects/$projectKey/settings')({
  component: SettingsPage,
});

function SettingsPage() {
  const { currentProject, workflow } = useProjectStore();

  if (!currentProject) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Project Settings</h1>

      <div className="bg-white rounded-lg shadow-sm border divide-y">
        {/* General */}
        <div className="p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">General</h2>
          <dl className="space-y-4">
            <div>
              <dt className="text-sm font-medium text-gray-500">Project Key</dt>
              <dd className="text-gray-900">{currentProject.key}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Project Name</dt>
              <dd className="text-gray-900">{currentProject.name}</dd>
            </div>
            {currentProject.description && (
              <div>
                <dt className="text-sm font-medium text-gray-500">Description</dt>
                <dd className="text-gray-900">{currentProject.description}</dd>
              </div>
            )}
          </dl>
        </div>

        {/* Workflow */}
        {workflow && (
          <div className="p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Workflow</h2>
            <p className="text-gray-500 mb-4">Statuses and transitions for this project</p>
            <div className="flex flex-wrap gap-2">
              {workflow.statuses.map((status) => (
                <span
                  key={status.id}
                  className={`px-3 py-1 rounded-full text-sm font-medium ${
                    status.category === 'todo'
                      ? 'bg-gray-200 text-gray-700'
                      : status.category === 'in_progress'
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-green-100 text-green-700'
                  }`}
                >
                  {status.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Danger Zone */}
        <div className="p-6">
          <h2 className="text-lg font-semibold text-red-600 mb-4">Danger Zone</h2>
          <p className="text-gray-500 mb-4">
            Deleting a project will permanently remove all issues, sprints, and data.
          </p>
          <button className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors">
            Delete Project
          </button>
        </div>
      </div>
    </div>
  );
}
