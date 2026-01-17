import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Header } from '../components/Header';

export const Route = createRootRoute({
  component: () => (
    <>
      <Header />
      <main className="min-h-screen bg-white">
        <Outlet />
      </main>
      <footer className="bg-gray-100 border-t border-gray-200 py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            <div>
              <h3 className="font-bold mb-4">Support</h3>
              <ul className="space-y-2 text-gray-600 text-sm">
                <li>Help Center</li>
                <li>Safety information</li>
                <li>Cancellation options</li>
              </ul>
            </div>
            <div>
              <h3 className="font-bold mb-4">Community</h3>
              <ul className="space-y-2 text-gray-600 text-sm">
                <li>Airbnb.org</li>
                <li>Host resources</li>
              </ul>
            </div>
            <div>
              <h3 className="font-bold mb-4">Hosting</h3>
              <ul className="space-y-2 text-gray-600 text-sm">
                <li>Try hosting</li>
                <li>Host responsibly</li>
              </ul>
            </div>
            <div>
              <h3 className="font-bold mb-4">Airbnb</h3>
              <ul className="space-y-2 text-gray-600 text-sm">
                <li>Newsroom</li>
                <li>Careers</li>
              </ul>
            </div>
          </div>
          <div className="mt-8 pt-8 border-t border-gray-300 text-center text-sm text-gray-500">
            <p>This is a demo project for learning system design.</p>
          </div>
        </div>
      </footer>
    </>
  ),
});
