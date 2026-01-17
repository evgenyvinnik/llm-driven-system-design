import { createFileRoute, redirect } from '@tanstack/react-router';
import { useAuthStore, useWorkspaceStore, usePageStore } from '@/stores';
import { useEffect } from 'react';
import Sidebar from '@/components/sidebar/Sidebar';

function IndexPage() {
  const { isAuthenticated } = useAuthStore();
  const { workspaces, currentWorkspace, fetchWorkspaces } = useWorkspaceStore();
  const { pages, fetchPages } = usePageStore();

  useEffect(() => {
    if (isAuthenticated) {
      fetchWorkspaces();
    }
  }, [isAuthenticated, fetchWorkspaces]);

  useEffect(() => {
    if (currentWorkspace) {
      fetchPages(currentWorkspace.id);
    }
  }, [currentWorkspace, fetchPages]);

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className="h-screen flex">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <div className="max-w-4xl mx-auto p-8">
          <h1 className="text-4xl font-bold mb-4">
            {currentWorkspace?.icon} {currentWorkspace?.name || 'Select a workspace'}
          </h1>
          <p className="text-notion-text-secondary mb-8">
            Select a page from the sidebar to get started, or create a new page.
          </p>

          {pages.filter((p) => !p.parent_id).length === 0 ? (
            <div className="text-center py-12 bg-notion-background-secondary rounded-lg">
              <p className="text-notion-text-secondary mb-4">No pages yet</p>
              <p className="text-sm text-notion-text-secondary">
                Click the + button in the sidebar to create your first page
              </p>
            </div>
          ) : (
            <div className="grid gap-4">
              {pages
                .filter((p) => !p.parent_id)
                .map((page) => (
                  <a
                    key={page.id}
                    href={`/page/${page.id}`}
                    className="flex items-center gap-3 p-4 bg-notion-background-secondary rounded-lg hover:bg-notion-hover transition-colors"
                  >
                    <span className="text-2xl">{page.icon || (page.is_database ? '📊' : '📄')}</span>
                    <div>
                      <h3 className="font-medium">{page.title || 'Untitled'}</h3>
                      <p className="text-sm text-notion-text-secondary">
                        {page.is_database ? 'Database' : 'Page'}
                      </p>
                    </div>
                  </a>
                ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export const Route = createFileRoute('/')({
  beforeLoad: ({ context }) => {
    const isAuthenticated = useAuthStore.getState().isAuthenticated;
    if (!isAuthenticated) {
      throw redirect({ to: '/login' });
    }
  },
  component: IndexPage,
});
