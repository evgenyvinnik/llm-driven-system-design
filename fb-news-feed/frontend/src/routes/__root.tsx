import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Header } from '@/components/Header';

export const Route = createRootRoute({
  component: () => (
    <div className="min-h-screen bg-facebook-gray">
      <Header />
      <main className="pt-14">
        <Outlet />
      </main>
    </div>
  ),
});
