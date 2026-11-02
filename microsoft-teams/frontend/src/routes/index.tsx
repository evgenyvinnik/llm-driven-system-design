import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import { orgApi } from '../services/api';

function IndexPage() {
  const user = useAuthStore((s) => s.user);
  const { organizations, loadOrganizations } = useChatStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) {
      loadOrganizations();
    }
  }, [user, loadOrganizations]);

  useEffect(() => {
    if (organizations.length > 0) {
      // Auto-navigate to first org (teams/channels loaded later)
      navigate({
        to: '/org/$orgId',
        params: { orgId: organizations[0].id },
      });
    }
  }, [organizations, navigate]);

  if (!user) return null;

  return (
    <main className="min-h-screen flex items-center justify-center bg-teams-bg">
      <div className="bg-teams-surface rounded-lg shadow-lg p-8 max-w-md w-full text-center">
        <div className="text-6xl mb-4">💬</div>
        <h1 className="text-2xl font-bold text-teams-text mb-2">Welcome to Teams</h1>
        <p className="text-teams-secondary mb-6">
          {organizations.length === 0
            ? 'Create or join an organization to get started.'
            : 'Loading your workspace...'}
        </p>
        {organizations.length === 0 && (
          <button
            onClick={() => {
              const name = prompt('Organization name:');
              if (name) {
                orgApi
                  .create(name)
                  .then(() => loadOrganizations())
                  .catch((err) => alert(err instanceof Error ? err.message : 'Could not create organization'));
              }
            }}
            className="bg-teams-primary text-white px-6 py-2 rounded-md hover:bg-teams-hover transition-colors"
          >
            Create Organization
          </button>
        )}
      </div>
    </main>
  );
}

export const Route = createFileRoute('/')({
  component: IndexPage,
});
