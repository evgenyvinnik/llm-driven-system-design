import { createRootRoute, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore, useProjectStore, useUIStore } from '../stores';
import { Spinner } from '../components/ui';
import { CreateIssueModal } from '../components/CreateIssueModal';

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  const { isLoading, checkAuth } = useAuthStore();
  const { fetchProjects } = useProjectStore();
  const { createIssueModalOpen, setCreateIssueModalOpen } = useUIStore();

  useEffect(() => {
    checkAuth().then(() => {
      fetchProjects();
    });
  }, [checkAuth, fetchProjects]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        // Would open search modal
      }
      if (e.key === 'c' && !e.metaKey && !e.ctrlKey && document.activeElement?.tagName !== 'INPUT') {
        // Could open create modal
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <>
      <Outlet />
      <CreateIssueModal
        isOpen={createIssueModalOpen}
        onClose={() => setCreateIssueModalOpen(false)}
      />
    </>
  );
}
