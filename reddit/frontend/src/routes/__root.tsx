import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Header } from '../components/Header';

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <div className="min-h-screen bg-reddit-lightGray">
      <Header />
      <main className="max-w-5xl mx-auto px-4 py-4">
        <Outlet />
      </main>
    </div>
  );
}
