import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Header } from '../components/Header';

export const Route = createRootRoute({
  component: () => (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-8">
        <Outlet />
      </main>
      <footer className="bg-gray-100 py-4 text-center text-sm text-gray-600">
        Bitly URL Shortener - System Design Project
      </footer>
    </div>
  ),
});
