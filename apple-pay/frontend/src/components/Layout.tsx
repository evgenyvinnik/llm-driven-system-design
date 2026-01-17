/**
 * Layout component provides the main application shell.
 * Includes header with title and sign out, main content area,
 * and bottom navigation tabs.
 */
import { useEffect } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores';

/**
 * Props for the Layout component.
 */
interface LayoutProps {
  /** Child content to render in the main area */
  children: React.ReactNode;
  /** Page title shown in the header */
  title?: string;
  /** Whether to show a back button in the header */
  showBack?: boolean;
}

/**
 * Renders the main application layout with header, content, and navigation.
 * Automatically redirects to login page if user is not authenticated.
 *
 * @param props - Layout component props
 * @returns JSX element representing the app shell, or null if not logged in
 */
export function Layout({ children, title, showBack }: LayoutProps) {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (!user) {
      navigate({ to: '/login' });
    }
  }, [user, navigate]);

  if (!user) return null;

  return (
    <div className="min-h-screen bg-apple-gray-100">
      {/* Header */}
      <header className="bg-white border-b border-apple-gray-200 sticky top-0 z-40">
        <div className="max-w-lg mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {showBack && (
              <button
                onClick={() => window.history.back()}
                className="text-apple-blue"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            )}
            <h1 className="text-xl font-semibold text-apple-gray-900">
              {title || 'Wallet'}
            </h1>
          </div>
          <button
            onClick={logout}
            className="text-apple-blue text-sm"
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-lg mx-auto px-4 py-6 pb-24">
        {children}
      </main>

      {/* Bottom navigation */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-apple-gray-200 z-40">
        <div className="max-w-lg mx-auto px-4 py-2 flex justify-around">
          <NavLink to="/" icon="wallet" label="Wallet" />
          <NavLink to="/transactions" icon="history" label="History" />
          <NavLink to="/pay" icon="pay" label="Pay" />
          <NavLink to="/merchant" icon="store" label="Merchant" />
        </div>
      </nav>
    </div>
  );
}

/**
 * Navigation link component for bottom tab bar.
 * Renders an icon and label with active state styling.
 *
 * @param to - Route path to navigate to
 * @param icon - Icon key (wallet, history, pay, store)
 * @param label - Text label for the nav item
 * @returns JSX element representing a navigation tab
 */
function NavLink({ to, icon, label }: { to: string; icon: string; label: string }) {
  const icons = {
    wallet: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
      </svg>
    ),
    history: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    pay: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
      </svg>
    ),
    store: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
      </svg>
    ),
  };

  return (
    <Link
      to={to}
      className="flex flex-col items-center gap-1 py-2 px-4 text-apple-gray-500 [&.active]:text-apple-blue"
      activeProps={{ className: 'active text-apple-blue' }}
    >
      {icons[icon as keyof typeof icons]}
      <span className="text-xs">{label}</span>
    </Link>
  );
}
