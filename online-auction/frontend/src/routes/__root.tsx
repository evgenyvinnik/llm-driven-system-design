import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Header } from '../components/Header';

export const Route = createRootRoute({
  component: () => (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="bg-gray-800 text-white py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-gray-400">
            AuctionHub - Online Auction Platform
          </p>
        </div>
      </footer>
    </div>
  ),
});
