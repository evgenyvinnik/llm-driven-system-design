import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Navbar } from '../components/Navbar';

export const Route = createRootRoute({
  component: () => (
    <div className="min-h-screen bg-gray-bg">
      <Navbar />
      <main className="max-w-5xl mx-auto px-4 py-6">
        <Outlet />
      </main>
    </div>
  ),
});
