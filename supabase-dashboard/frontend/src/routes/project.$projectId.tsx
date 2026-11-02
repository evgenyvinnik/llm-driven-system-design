import { createFileRoute, Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useProjectStore } from '../stores/projectStore';
import { ProjectSidebar } from '../components/ProjectSidebar';
import { Breadcrumb } from '../components/Breadcrumb';

function ProjectLayout() {
  const { projectId } = Route.useParams();
  const { user, loading: authLoading } = useAuthStore();
  const { currentProject, projectError, loadProject } = useProjectStore();
  // Children render only once the project (and so the caller's role) is known for this ID.
  const ready = currentProject?.id === projectId;
  const navigate = useNavigate();

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: '/login' });
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user && projectId) {
      loadProject(projectId);
    }
  }, [user, projectId, loadProject]);

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-supabase-secondary">Loading...</div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="flex h-screen bg-supabase-bg overflow-hidden">
      <ProjectSidebar projectId={projectId} projectName={currentProject?.name || 'Project'} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Breadcrumb projectName={currentProject?.name || 'Project'} />
        <main className="flex-1 overflow-auto">
          {projectError ? (
            <div className="flex items-center justify-center h-full text-center">
              <div>
                <p className="text-lg text-supabase-text mb-2">Project not found</p>
                <p className="text-sm text-supabase-secondary mb-4">
                  It doesn&apos;t exist, or you aren&apos;t a member of it.
                </p>
                <Link to="/" className="text-supabase-primary hover:text-supabase-hover text-sm">
                  Back to projects
                </Link>
              </div>
            </div>
          ) : ready ? (
            <Outlet />
          ) : (
            <div className="p-6 text-supabase-secondary">Loading project...</div>
          )}
        </main>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/project/$projectId')({
  component: ProjectLayout,
});
