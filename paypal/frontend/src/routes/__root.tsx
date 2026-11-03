import { createRootRoute, Outlet, Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';

function Header() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  if (!user) return null;

  return (
    <header className="bg-paypal-sidebar text-white shadow-lg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center space-x-8">
            <Link to="/" className="text-xl font-bold tracking-tight">
              PayPal
            </Link>
            <nav className="flex space-x-4">
              <Link
                to="/"
                className="px-3 py-2 rounded-md text-sm font-medium hover:bg-white/10 transition-colors"
                activeProps={{ className: 'px-3 py-2 rounded-md text-sm font-medium bg-white/20' }}
              >
                Dashboard
              </Link>
              <Link
                to="/send"
                className="px-3 py-2 rounded-md text-sm font-medium hover:bg-white/10 transition-colors"
                activeProps={{ className: 'px-3 py-2 rounded-md text-sm font-medium bg-white/20' }}
              >
                Send
              </Link>
              <Link
                to="/request"
                className="px-3 py-2 rounded-md text-sm font-medium hover:bg-white/10 transition-colors"
                activeProps={{ className: 'px-3 py-2 rounded-md text-sm font-medium bg-white/20' }}
              >
                Request
              </Link>
              <Link
                to="/activity"
                className="px-3 py-2 rounded-md text-sm font-medium hover:bg-white/10 transition-colors"
                activeProps={{ className: 'px-3 py-2 rounded-md text-sm font-medium bg-white/20' }}
              >
                Activity
              </Link>
              <Link
                to="/payment-methods"
                className="px-3 py-2 rounded-md text-sm font-medium hover:bg-white/10 transition-colors"
                activeProps={{ className: 'px-3 py-2 rounded-md text-sm font-medium bg-white/20' }}
              >
                Wallet
              </Link>
              {user.role === 'admin' && (
                <Link
                  to="/admin"
                  className="px-3 py-2 rounded-md text-sm font-medium hover:bg-white/10 transition-colors"
                  activeProps={{ className: 'px-3 py-2 rounded-md text-sm font-medium bg-white/20' }}
                >
                  Admin
                </Link>
              )}
            </nav>
          </div>
          <div className="flex items-center space-x-4">
            <span className="text-sm text-white/80">{user.username}</span>
            <button
              onClick={() => logout()}
              className="px-3 py-1.5 text-sm bg-white/10 hover:bg-white/20 rounded-md transition-colors"
            >
              Log out
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

function RootComponent() {
  const checkAuth = useAuthStore((s) => s.checkAuth);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return (
    <div className="min-h-screen bg-paypal-bg">
      <Header />
      {/* Main landmark for assistive tech; the smoke tests also key on it. */}
      <main>
        <Outlet />
      </main>
    </div>
  );
}

export const Route = createRootRoute({
  component: RootComponent,
});
