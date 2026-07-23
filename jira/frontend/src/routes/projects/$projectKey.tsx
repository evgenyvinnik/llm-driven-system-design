import { createFileRoute, Outlet, Navigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useProjectStore } from '../../stores';
import { Spinner } from '../../components/ui';
import { getProject } from '../../services/api';

export const Route = createFileRoute('/projects/$projectKey')({
  component: ProjectLayout,
});

/**
 * Resolves the :projectKey URL segment to a loaded project before rendering any
 * child route (board, backlog, issues, settings).
 *
 * The redirect to /projects must key off `notFound` rather than `!currentProject`.
 * The store starts with `currentProject: null` and `isLoading: false`, and effects
 * only run after the first paint — so a `!currentProject` guard fires on mount for
 * every deep link, bouncing the user back to the project list before the fetch even
 * starts.
 */
function ProjectLayout() {
  const { projectKey } = useParams({ from: '/projects/$projectKey' });
  const { currentProject, fetchProjectDetails } = useProjectStore();
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadProject = async () => {
      setNotFound(false);
      try {
        const project = await getProject(projectKey);
        if (cancelled) return;
        if (project) {
          await fetchProjectDetails(project.id);
        } else {
          setNotFound(true);
        }
      } catch (error) {
        console.error('Failed to load project:', error);
        if (!cancelled) setNotFound(true);
      }
    };

    loadProject();
    return () => {
      cancelled = true;
    };
  }, [projectKey, fetchProjectDetails]);

  if (notFound) {
    return <Navigate to="/projects" />;
  }

  // Keep showing the spinner while the fetch is in flight, and while a stale
  // project from a previous key is still in the store.
  if (!currentProject || currentProject.key !== projectKey) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  return <Outlet />;
}
