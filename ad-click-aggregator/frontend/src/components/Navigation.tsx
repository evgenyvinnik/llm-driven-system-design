import { Link, useRouterState } from '@tanstack/react-router';

export function Navigation() {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  const navItems = [
    { path: '/', label: 'Dashboard' },
    { path: '/campaigns', label: 'Campaigns' },
    { path: '/analytics', label: 'Analytics' },
    { path: '/clicks', label: 'Recent Clicks' },
    { path: '/test', label: 'Test Clicks' },
  ];

  return (
    <nav className="bg-gray-900 text-white">
      <div className="mx-auto max-w-7xl px-4">
        <div className="flex h-16 items-center justify-between">
          <div className="flex items-center gap-8">
            <Link to="/" className="text-xl font-bold text-white">
              Ad Click Aggregator
            </Link>
            <div className="flex gap-1">
              {navItems.map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`rounded-md px-3 py-2 text-sm font-medium transition ${
                    currentPath === item.path
                      ? 'bg-gray-700 text-white'
                      : 'text-gray-300 hover:bg-gray-700 hover:text-white'
                  }`}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
          <div className="text-sm text-gray-400">
            Real-time Ad Analytics
          </div>
        </div>
      </div>
    </nav>
  );
}
