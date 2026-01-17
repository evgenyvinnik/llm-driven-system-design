import { Link } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';

export function Header() {
  const { user, logout } = useAuthStore();

  return (
    <header className="bg-white shadow-sm">
      <div className="max-w-7xl mx-auto px-4 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-8">
            <Link to="/" className="text-2xl font-bold text-primary-600">
              Bitly
            </Link>

            <nav className="flex items-center gap-4">
              <Link
                to="/"
                className="text-gray-600 hover:text-gray-900 [&.active]:font-semibold [&.active]:text-gray-900"
              >
                Home
              </Link>
              {user && (
                <Link
                  to="/dashboard"
                  className="text-gray-600 hover:text-gray-900 [&.active]:font-semibold [&.active]:text-gray-900"
                >
                  Dashboard
                </Link>
              )}
              {user?.role === 'admin' && (
                <Link
                  to="/admin"
                  className="text-gray-600 hover:text-gray-900 [&.active]:font-semibold [&.active]:text-gray-900"
                >
                  Admin
                </Link>
              )}
            </nav>
          </div>

          <div className="flex items-center gap-4">
            {user ? (
              <>
                <span className="text-sm text-gray-600">
                  {user.email}
                  {user.role === 'admin' && (
                    <span className="ml-2 text-xs bg-primary-100 text-primary-800 px-2 py-0.5 rounded">
                      Admin
                    </span>
                  )}
                </span>
                <button onClick={() => logout()} className="btn btn-secondary text-sm">
                  Logout
                </button>
              </>
            ) : (
              <Link to="/login" className="btn btn-primary text-sm">
                Login
              </Link>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
