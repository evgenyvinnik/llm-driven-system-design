import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Navbar } from '@/components/Navbar';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <main>
        <Outlet />
      </main>
    </div>
  );
}
