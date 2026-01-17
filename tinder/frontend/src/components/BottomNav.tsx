import { Link, useLocation } from '@tanstack/react-router';
import { useMatchStore } from '../stores/matchStore';

export default function BottomNav() {
  const location = useLocation();
  const { unreadCount } = useMatchStore();

  const navItems = [
    {
      to: '/',
      icon: (active: boolean) => (
        <svg
          className={`w-7 h-7 ${active ? 'text-gradient-start' : 'text-gray-400'}`}
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M12.0001 2C7.95721 5.50456 6.00098 9.00911 6.00098 12.5137C6.00098 17.5 9.00098 21 12.001 21C15.001 21 18.001 17.5 18.001 12.5137C18.001 9.00911 16.043 5.50456 12.0001 2Z" />
        </svg>
      ),
      label: 'Discover',
    },
    {
      to: '/matches',
      icon: (active: boolean) => (
        <div className="relative">
          <svg
            className={`w-7 h-7 ${active ? 'text-gradient-start' : 'text-gray-400'}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 w-4 h-4 bg-gradient-start text-white text-xs rounded-full flex items-center justify-center">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </div>
      ),
      label: 'Messages',
    },
    {
      to: '/profile',
      icon: (active: boolean) => (
        <svg
          className={`w-7 h-7 ${active ? 'text-gradient-start' : 'text-gray-400'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
          />
        </svg>
      ),
      label: 'Profile',
    },
  ];

  return (
    <nav className="bg-white border-t border-gray-200 px-6 py-2 safe-area-pb">
      <div className="flex items-center justify-around">
        {navItems.map((item) => {
          const isActive = location.pathname === item.to;
          return (
            <Link
              key={item.to}
              to={item.to}
              className="flex flex-col items-center py-2 px-4"
            >
              {item.icon(isActive)}
              <span
                className={`text-xs mt-1 ${
                  isActive ? 'text-gradient-start font-medium' : 'text-gray-400'
                }`}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
