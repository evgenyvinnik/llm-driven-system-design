import { Link } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';

export default function Header() {
  const { user, logout } = useAuthStore();

  return (
    <header className="bg-white border-b border-docs-border px-4 py-2 flex items-center justify-between sticky top-0 z-50">
      <Link to="/" className="flex items-center gap-2">
        <svg className="w-10 h-10" viewBox="0 0 48 48" fill="none">
          <path d="M7 6C7 4.89543 7.89543 4 9 4H29L41 16V42C41 43.1046 40.1046 44 39 44H9C7.89543 44 7 43.1046 7 42V6Z" fill="#4285F4"/>
          <path d="M29 4L41 16H31C29.8954 16 29 15.1046 29 14V4Z" fill="#A1C2FA"/>
          <path d="M14 24H34M14 30H34M14 36H26" stroke="white" strokeWidth="2" strokeLinecap="round"/>
        </svg>
        <span className="text-xl text-gray-700 hidden sm:inline">Docs</span>
      </Link>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-white font-medium text-sm"
            style={{ backgroundColor: user?.avatar_color || '#3B82F6' }}
          >
            {user?.name?.charAt(0).toUpperCase()}
          </div>
          <span className="text-sm text-gray-700 hidden sm:inline">{user?.name}</span>
        </div>

        <button
          onClick={logout}
          className="text-sm text-gray-600 hover:text-gray-800 px-3 py-1 rounded hover:bg-gray-100"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
