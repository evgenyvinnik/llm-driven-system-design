import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';

// Layout for /bookings/*. The list (bookings.index.tsx) and the detail page
// (bookings.$bookingId.tsx) render through this Outlet, so both sit behind the guard.
export const Route = createFileRoute('/bookings')({
  beforeLoad: async () => {
    const { isAuthenticated, checkAuth, isLoading } = useAuthStore.getState();
    if (!isAuthenticated && !isLoading) {
      await checkAuth();
      if (!useAuthStore.getState().isAuthenticated) {
        throw redirect({ to: '/login' });
      }
    }
  },
  component: Outlet,
});
