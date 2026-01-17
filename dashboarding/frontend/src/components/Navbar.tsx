import { Link, useLocation } from '@tanstack/react-router';
import { clsx } from 'clsx';

interface NavItem {
  path: string;
  label: string;
}

const navItems: NavItem[] = [
  { path: '/', label: 'Dashboards' },
  { path: '/alerts', label: 'Alerts' },
  { path: '/metrics', label: 'Metrics' },
];

export function Navbar() {
  const location = useLocation();

  return (
    <nav className="bg-dashboard-card border-b border-dashboard-accent">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex items-center justify-between h-14">
          <div className="flex items-center gap-8">
            <Link to="/" className="text-xl font-bold text-dashboard-highlight">
              Metrics Dashboard
            </Link>
            <div className="flex items-center gap-4">
              {navItems.map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  className={clsx(
                    'px-3 py-2 rounded-md text-sm font-medium transition-colors',
                    location.pathname === item.path
                      ? 'bg-dashboard-accent text-dashboard-text'
                      : 'text-dashboard-muted hover:text-dashboard-text hover:bg-dashboard-accent/50'
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-dashboard-muted">
              {new Date().toLocaleDateString()}
            </span>
          </div>
        </div>
      </div>
    </nav>
  );
}
