import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { UrlShortener } from '../components/UrlShortener';
import { UrlList } from '../components/UrlList';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/dashboard')({
  component: DashboardPage,
});

function DashboardPage() {
  const { user, checkAuth } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (!user) {
      checkAuth().then(() => {
        const currentUser = useAuthStore.getState().user;
        if (!currentUser) {
          navigate({ to: '/login' });
        }
      });
    }
  }, [user, checkAuth, navigate]);

  if (!user) {
    return <div className="text-center py-8">Loading...</div>;
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <div className="grid lg:grid-cols-2 gap-8">
        <div>
          <UrlShortener />
        </div>
        <div className="lg:col-span-2">
          <UrlList />
        </div>
      </div>
    </div>
  );
}
