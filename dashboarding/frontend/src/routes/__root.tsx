import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Navbar } from '../components/Navbar';
import { AlertBanner } from '../components/AlertBanner';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-screen bg-dashboard-bg">
      <Navbar />
      <AlertBanner />
      <main>
        <Outlet />
      </main>
    </div>
  );
}
