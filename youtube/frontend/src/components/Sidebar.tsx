import { Link, useLocation } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';

const menuItems = [
  { icon: 'home', label: 'Home', path: '/' },
  { icon: 'trending', label: 'Trending', path: '/trending' },
  { icon: 'subscriptions', label: 'Subscriptions', path: '/subscriptions', requiresAuth: true },
  { icon: 'history', label: 'History', path: '/history', requiresAuth: true },
];

const icons: Record<string, JSX.Element> = {
  home: (
    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
      <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
    </svg>
  ),
  trending: (
    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
      <path d="M17.53 11.2c-.23-.3-.5-.56-.76-.82-.65-.6-1.4-1.03-2.03-1.66C13.3 7.26 13 5.62 13.5 4c-1.75.63-3.08 2.15-3.65 3.83-.06.2-.1.4-.13.62-.17 1.22.13 2.53.84 3.55-.47.06-.9-.08-1.28-.37-.23-.18-.43-.43-.6-.72-.18-.3-.3-.63-.37-.97.02.01.05.03.07.04.57.36 1.26.54 1.97.54.53 0 1.06-.1 1.56-.3.47-.2.9-.5 1.25-.87l.04-.05c.76-.84 1.17-1.97 1.1-3.13-.07-.9-.43-1.77-1.03-2.45-.64-.75-1.52-1.27-2.5-1.47-.52-.1-1.06-.13-1.6-.08-.72.07-1.42.27-2.05.6-.32.17-.62.38-.9.62C5.6 4.17 5.09 5.35 5 6.58c-.02.27-.02.54 0 .8.05.65.22 1.28.5 1.86.26.54.62 1.03 1.05 1.46.4.4.86.76 1.36 1.05-.44.08-.88.13-1.32.13-.81 0-1.62-.16-2.36-.48v.06c0 .97.32 1.9.9 2.66.58.76 1.4 1.3 2.32 1.53-.45.12-.92.18-1.4.18-.33 0-.66-.03-.98-.1.32 1.02.97 1.9 1.86 2.52.9.62 1.96.96 3.06.96h.06c1.1 0 2.16-.34 3.06-.96.9-.62 1.56-1.5 1.88-2.52-.33.06-.67.1-1 .1-.48 0-.95-.06-1.4-.18.93-.24 1.74-.78 2.33-1.53.58-.76.9-1.7.9-2.66v-.06c-.75.32-1.56.48-2.37.48"/>
    </svg>
  ),
  subscriptions: (
    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
      <path d="M10 18v-6l5 3-5 3zm7-15H7v2h10V3zm3 4H4v2h16V7zm2 4H2v10h20V11z"/>
    </svg>
  ),
  history: (
    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
      <path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>
    </svg>
  ),
};

interface SidebarProps {
  collapsed?: boolean;
}

export default function Sidebar({ collapsed = false }: SidebarProps) {
  const location = useLocation();
  const { user } = useAuthStore();

  const filteredItems = menuItems.filter(
    (item) => !item.requiresAuth || user
  );

  if (collapsed) {
    return (
      <aside className="fixed left-0 top-14 bottom-0 w-[72px] bg-yt-dark overflow-y-auto py-2">
        {filteredItems.map((item) => (
          <Link
            key={item.path}
            to={item.path}
            className={`flex flex-col items-center gap-1 py-4 px-1 text-xs hover:bg-yt-dark-hover ${
              location.pathname === item.path ? 'bg-yt-dark-hover' : ''
            }`}
          >
            {icons[item.icon]}
            <span className="text-[10px]">{item.label}</span>
          </Link>
        ))}
      </aside>
    );
  }

  return (
    <aside className="fixed left-0 top-14 bottom-0 w-60 bg-yt-dark overflow-y-auto py-2 px-3">
      {filteredItems.map((item) => (
        <Link
          key={item.path}
          to={item.path}
          className={`sidebar-item ${
            location.pathname === item.path ? 'active' : ''
          }`}
        >
          {icons[item.icon]}
          <span>{item.label}</span>
        </Link>
      ))}

      {user && (
        <>
          <hr className="my-3 border-gray-700" />
          <h3 className="px-3 py-2 text-sm font-medium text-gray-400">Your channel</h3>
          <Link
            to="/channel/$channelId"
            params={{ channelId: user.id }}
            className="sidebar-item"
          >
            <div className="w-6 h-6 rounded-full bg-yt-red flex items-center justify-center text-xs">
              {user.username.charAt(0).toUpperCase()}
            </div>
            <span>{user.channelName}</span>
          </Link>
        </>
      )}
    </aside>
  );
}
