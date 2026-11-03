import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import { Sidebar } from '../components/Sidebar';

function OrgLayout() {
  const user = useAuthStore((s) => s.user);
  const { loadOrganizations, organizations, startPresenceHeartbeat } = useChatStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (!user) {
      navigate({ to: '/login' });
      return;
    }
    loadOrganizations();
    const stopHeartbeat = startPresenceHeartbeat();
    return stopHeartbeat;
  }, [user, loadOrganizations, navigate, startPresenceHeartbeat]);

  if (!user) return null;

  return (
    <div className="h-screen flex overflow-hidden">
      <Sidebar organizations={organizations} />
      <main className="flex-1 flex overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}

export const Route = createFileRoute('/org')({
  component: OrgLayout,
});
