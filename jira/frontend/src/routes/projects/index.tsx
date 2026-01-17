import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useProjectStore } from '../../stores';
import { Button, Input, Spinner, EmptyState, Modal, Textarea } from '../../components/ui';
import * as api from '../../services/api';

export const Route = createFileRoute('/projects/')({
  component: ProjectsIndexPage,
});

function ProjectsIndexPage() {
  const { projects, isLoading, fetchProjects } = useProjectStore();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Projects</h1>
        <Button onClick={() => setShowCreateModal(true)}>Create Project</Button>
      </div>

      {projects.length === 0 ? (
        <EmptyState
          message="No projects yet"
          action={{ label: 'Create your first project', onClick: () => setShowCreateModal(true) }}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((project) => (
            <Link
              key={project.id}
              to="/projects/$projectKey"
              params={{ projectKey: project.key }}
              className="bg-white rounded-lg shadow-sm border p-4 hover:shadow-md transition-shadow"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 bg-blue-500 text-white rounded flex items-center justify-center font-bold">
                  {project.key.slice(0, 2)}
                </div>
                <div>
                  <h2 className="font-semibold text-gray-900">{project.name}</h2>
                  <p className="text-sm text-gray-500">{project.key}</p>
                </div>
              </div>
              {project.description && (
                <p className="text-sm text-gray-600 line-clamp-2">{project.description}</p>
              )}
            </Link>
          ))}
        </div>
      )}

      <CreateProjectModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={(project) => {
          fetchProjects();
          setShowCreateModal(false);
          navigate({ to: '/projects/$projectKey', params: { projectKey: project.key } });
        }}
      />
    </div>
  );
}

function CreateProjectModal({
  isOpen,
  onClose,
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (project: { key: string }) => void;
}) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!key.trim() || !name.trim()) {
      setError('Key and name are required');
      return;
    }

    if (!/^[A-Za-z]{2,10}$/.test(key)) {
      setError('Key must be 2-10 letters');
      return;
    }

    setIsSubmitting(true);
    setError('');

    try {
      const project = await api.createProject({
        key: key.toUpperCase(),
        name: name.trim(),
        description: description.trim() || undefined,
      });
      setKey('');
      setName('');
      setDescription('');
      onCreated(project);
    } catch (err) {
      setError((err as Error).message || 'Failed to create project');
    }

    setIsSubmitting(false);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create Project" size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <div className="p-3 bg-red-50 text-red-700 rounded text-sm">{error}</div>}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Project Key <span className="text-red-500">*</span>
          </label>
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
            placeholder="PROJ"
          />
          <p className="text-xs text-gray-500 mt-1">2-10 uppercase letters</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Project Name <span className="text-red-500">*</span>
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Project"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this project about?"
            rows={3}
          />
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Creating...' : 'Create Project'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
