import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { AdminDashboard } from '../components/AdminDashboard';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/admin')({
  component: AdminPage,
});

function AdminPage() {
  const { user, checkAuth } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (!user) {
      checkAuth().then(() => {
        const currentUser = useAuthStore.getState().user;
        if (!currentUser) {
          navigate({ to: '/login' });
        } else if (currentUser.role !== 'admin') {
          navigate({ to: '/dashboard' });
        }
      });
    } else if (user.role !== 'admin') {
      navigate({ to: '/dashboard' });
    }
  }, [user, checkAuth, navigate]);

  if (!user || user.role !== 'admin') {
    return <div className="text-center py-8">Loading...</div>;
  }

  return <AdminDashboard />;
}
