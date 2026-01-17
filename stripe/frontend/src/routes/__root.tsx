import { createRootRoute, Outlet } from '@tanstack/react-router';
import { useMerchantStore } from '@/stores';
import { Sidebar, LoginForm } from '@/components';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const { apiKey } = useMerchantStore();

  if (!apiKey) {
    return <LoginForm />;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-8 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
