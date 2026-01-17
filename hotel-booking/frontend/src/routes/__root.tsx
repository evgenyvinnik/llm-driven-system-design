import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Header } from '@/components';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <>
      <Header />
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="bg-gray-900 text-white py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            <div>
              <h3 className="text-lg font-semibold mb-4">HotelBook</h3>
              <p className="text-gray-400 text-sm">
                Find and book the perfect hotel for your next adventure.
              </p>
            </div>
            <div>
              <h4 className="font-medium mb-4">Support</h4>
              <ul className="space-y-2 text-gray-400 text-sm">
                <li>Help Center</li>
                <li>Safety Information</li>
                <li>Cancellation Options</li>
              </ul>
            </div>
            <div>
              <h4 className="font-medium mb-4">Company</h4>
              <ul className="space-y-2 text-gray-400 text-sm">
                <li>About Us</li>
                <li>Careers</li>
                <li>Press</li>
              </ul>
            </div>
            <div>
              <h4 className="font-medium mb-4">For Hotels</h4>
              <ul className="space-y-2 text-gray-400 text-sm">
                <li>List Your Property</li>
                <li>Partner Portal</li>
                <li>Resources</li>
              </ul>
            </div>
          </div>
          <div className="border-t border-gray-800 mt-8 pt-8 text-center text-gray-400 text-sm">
            &copy; {new Date().getFullYear()} HotelBook. All rights reserved.
          </div>
        </div>
      </footer>
    </>
  );
}
