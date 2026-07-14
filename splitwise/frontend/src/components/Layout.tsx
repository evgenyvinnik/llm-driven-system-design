import { Link, useLocation } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useAuthStore } from '../stores';
import { Avatar } from './Avatar';
import { HomeIcon, UsersIcon, ActivityIcon, LogoutIcon } from './icons';

const NAV = [
  { path: '/', label: 'Dashboard', Icon: HomeIcon, exact: true },
  { path: '/groups', label: 'Groups', Icon: UsersIcon, exact: false },
  { path: '/activity', label: 'Activity', Icon: ActivityIcon, exact: true },
];

function isActive(pathname: string, path: string, exact: boolean): boolean {
  return exact ? pathname === path : pathname === path || pathname.startsWith(path + '/');
}

/** App shell: sticky brand header, desktop side-nav, and mobile bottom-nav. */
export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuthStore();
  const location = useLocation();

  return (
    <div className="min-h-screen bg-split-bg">
      {/* Header */}
      <header className="bg-white/90 backdrop-blur border-b border-split-line sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-split-green flex items-center justify-center text-white font-black">S</span>
            <span className="text-lg font-extrabold text-split-ink tracking-tight">Splitwise</span>
          </Link>
          {user && (
            <div className="flex items-center gap-3">
              <div className="hidden sm:flex flex-col items-end leading-tight">
                <span className="text-sm font-semibold text-split-ink">{user.name || user.username}</span>
                <span className="text-xs text-split-ink-soft">@{user.username}</span>
              </div>
              <Avatar src={user.avatar_url} name={user.name || user.username} size="sm" />
              <button
                onClick={() => logout()}
                className="text-split-ink-soft hover:text-split-owe-dark p-1.5 rounded-lg hover:bg-split-bg"
                title="Log out"
              >
                <LogoutIcon className="w-5 h-5" />
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="max-w-5xl mx-auto sm:flex">
        {/* Desktop side nav */}
        {user && (
          <nav className="hidden sm:flex flex-col gap-1 w-48 shrink-0 px-3 py-6 sticky top-14 self-start">
            {NAV.map(({ path, label, Icon, exact }) => {
              const active = isActive(location.pathname, path, exact);
              return (
                <Link
                  key={path}
                  to={path}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl font-medium transition ${
                    active ? 'bg-split-green/10 text-split-green-dark' : 'text-split-ink-soft hover:bg-white'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                  {label}
                </Link>
              );
            })}
          </nav>
        )}

        {/* Main content */}
        <main className="flex-1 px-4 py-6 pb-24 sm:pb-8 min-w-0">{children}</main>
      </div>

      {/* Mobile bottom nav */}
      {user && (
        <nav className="sm:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-split-line px-4 py-2 z-40">
          <div className="max-w-5xl mx-auto flex justify-around">
            {NAV.map(({ path, label, Icon, exact }) => {
              const active = isActive(location.pathname, path, exact);
              return (
                <Link
                  key={path}
                  to={path}
                  className={`flex flex-col items-center gap-1 px-4 py-1.5 rounded-lg transition ${
                    active ? 'text-split-green-dark' : 'text-split-ink-soft'
                  }`}
                >
                  <Icon className="w-6 h-6" />
                  <span className="text-[11px] font-medium">{label}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      )}
    </div>
  );
}
