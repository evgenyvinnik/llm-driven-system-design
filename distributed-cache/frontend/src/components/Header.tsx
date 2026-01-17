import { Link, useRouterState } from '@tanstack/react-router';

export function Header() {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  const navItems = [
    { path: '/', label: 'Dashboard' },
    { path: '/keys', label: 'Keys' },
    { path: '/cluster', label: 'Cluster' },
    { path: '/test', label: 'Test' },
  ];

  return (
    <header className="bg-primary-700 text-white shadow-lg">
      <div className="max-w-7xl mx-auto px-4 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <svg
              className="w-8 h-8"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" opacity="0.3" />
              <path d="M9 9h6M9 12h6M9 15h6" strokeWidth="2" />
            </svg>
            <h1 className="text-xl font-bold">Distributed Cache</h1>
          </div>

          <nav className="flex gap-1">
            {navItems.map((item) => (
              <Link
                key={item.path}
                to={item.path}
                className={`px-4 py-2 rounded-md transition-colors ${
                  currentPath === item.path
                    ? 'bg-primary-600 text-white'
                    : 'text-primary-100 hover:bg-primary-600 hover:text-white'
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </header>
  );
}
