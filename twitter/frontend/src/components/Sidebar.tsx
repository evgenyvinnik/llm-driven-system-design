import { Link, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';

export function Sidebar() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/login' });
  };

  return (
    <aside className="w-64 flex flex-col h-screen sticky top-0 p-4">
      <div className="flex-1">
        <Link to="/" className="block p-3 hover:bg-gray-100 rounded-full w-fit">
          <svg viewBox="0 0 24 24" className="w-8 h-8 text-twitter-blue fill-current">
            <path d="M23.643 4.937c-.835.37-1.732.62-2.675.733.962-.576 1.7-1.49 2.048-2.578-.9.534-1.897.922-2.958 1.13-.85-.904-2.06-1.47-3.4-1.47-2.572 0-4.658 2.086-4.658 4.66 0 .364.042.718.12 1.06-3.873-.195-7.304-2.05-9.602-4.868-.4.69-.63 1.49-.63 2.342 0 1.616.823 3.043 2.072 3.878-.764-.025-1.482-.234-2.11-.583v.06c0 2.257 1.605 4.14 3.737 4.568-.392.106-.803.162-1.227.162-.3 0-.593-.028-.877-.082.593 1.85 2.313 3.198 4.352 3.234-1.595 1.25-3.604 1.995-5.786 1.995-.376 0-.747-.022-1.112-.065 2.062 1.323 4.51 2.093 7.14 2.093 8.57 0 13.255-7.098 13.255-13.254 0-.2-.005-.402-.014-.602.91-.658 1.7-1.477 2.323-2.41z" />
          </svg>
        </Link>

        <nav className="mt-4 space-y-2">
          <Link
            to="/"
            className="flex items-center gap-4 p-3 hover:bg-gray-100 rounded-full text-xl transition-colors"
            activeProps={{ className: 'font-bold' }}
          >
            <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
            <span>Home</span>
          </Link>

          <Link
            to="/explore"
            className="flex items-center gap-4 p-3 hover:bg-gray-100 rounded-full text-xl transition-colors"
            activeProps={{ className: 'font-bold' }}
          >
            <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <span>Explore</span>
          </Link>

          {user && (
            <>
              <Link
                to={`/${user.username}`}
                className="flex items-center gap-4 p-3 hover:bg-gray-100 rounded-full text-xl transition-colors"
                activeProps={{ className: 'font-bold' }}
              >
                <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
                <span>Profile</span>
              </Link>

              <button
                onClick={() => {
                  // Open compose modal or scroll to compose
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                className="w-full mt-4 px-8 py-3 bg-twitter-blue text-white rounded-full font-bold text-lg hover:bg-blue-600 transition-colors"
              >
                Tweet
              </button>
            </>
          )}
        </nav>
      </div>

      {user ? (
        <div className="border-t border-twitter-extraLightGray pt-4">
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 p-3 hover:bg-gray-100 rounded-full w-full transition-colors"
          >
            <div className="w-10 h-10 rounded-full bg-twitter-blue flex items-center justify-center text-white font-bold">
              {user.displayName.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 text-left">
              <p className="font-bold text-sm">{user.displayName}</p>
              <p className="text-twitter-gray text-sm">@{user.username}</p>
            </div>
            <svg className="w-5 h-5 text-twitter-gray" fill="currentColor" viewBox="0 0 20 20">
              <path d="M6 10a2 2 0 11-4 0 2 2 0 014 0zM12 10a2 2 0 11-4 0 2 2 0 014 0zM16 12a2 2 0 100-4 2 2 0 000 4z" />
            </svg>
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <Link
            to="/login"
            className="block w-full px-8 py-3 bg-twitter-blue text-white rounded-full font-bold text-center hover:bg-blue-600 transition-colors"
          >
            Log in
          </Link>
          <Link
            to="/register"
            className="block w-full px-8 py-3 border border-twitter-blue text-twitter-blue rounded-full font-bold text-center hover:bg-blue-50 transition-colors"
          >
            Sign up
          </Link>
        </div>
      )}
    </aside>
  );
}
