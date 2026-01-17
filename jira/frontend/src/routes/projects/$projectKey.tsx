import { createFileRoute, Outlet, Navigate, useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useProjectStore } from '../../stores';
import { Spinner } from '../../components/ui';

export const Route = createFileRoute('/projects/$projectKey')({
  component: ProjectLayout,
});

function ProjectLayout() {
  const { projectKey } = useParams({ from: '/projects/$projectKey' });
  const { currentProject, fetchProjectDetails, isLoading } = useProjectStore();

  useEffect(() => {
    // Fetch project by key
    const loadProject = async () => {
      try {
        const { getProject } = await import('../../services/api');
        const project = await getProject(projectKey);
        if (project) {
          await fetchProjectDetails(project.id);
        }
      } catch (error) {
        console.error('Failed to load project:', error);
      }
    };
    loadProject();
  }, [projectKey, fetchProjectDetails]);

  if (isLoading && !currentProject) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!currentProject) {
    return <Navigate to="/projects" />;
  }

  return <Outlet />;
}
