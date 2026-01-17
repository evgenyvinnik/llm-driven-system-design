import { createFileRoute, Link, Outlet, Navigate, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore, useProjectStore, useUIStore } from '../stores';
import { Layout } from '../components/Layout';
import { Button, Spinner, EmptyState } from '../components/ui';

export const Route = createFileRoute('/projects')({
  component: ProjectsLayout,
});

function ProjectsLayout() {
  const { isAuthenticated } = useAuthStore();
  const { projects, isLoading, fetchProjects } = useProjectStore();

  useEffect(() => {
    if (isAuthenticated) {
      fetchProjects();
    }
  }, [isAuthenticated, fetchProjects]);

  if (!isAuthenticated) {
    return <Navigate to="/" />;
  }

  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}
