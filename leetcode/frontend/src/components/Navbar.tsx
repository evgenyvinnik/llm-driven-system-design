import { Link } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';

export function Navbar() {
  const { user, isAuthenticated, logout } = useAuthStore();

  const handleLogout = async () => {
    try {
      await logout();
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  return (
    <nav className="bg-dark-300 border-b border-dark-100 px-4 py-3">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link to="/" className="text-xl font-bold text-primary-500">
            LeetCode
          </Link>
          <div className="flex items-center gap-4">
            <Link
              to="/problems"
              className="text-gray-300 hover:text-white transition-colors"
            >
              Problems
            </Link>
            {isAuthenticated && (
              <Link
                to="/progress"
                className="text-gray-300 hover:text-white transition-colors"
              >
                Progress
              </Link>
            )}
            {user?.role === 'admin' && (
              <Link
                to="/admin"
                className="text-gray-300 hover:text-white transition-colors"
              >
                Admin
              </Link>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
          {isAuthenticated ? (
            <>
              <span className="text-gray-400">
                Welcome, <span className="text-white">{user?.username}</span>
              </span>
              <button
                onClick={handleLogout}
                className="px-4 py-2 text-sm text-gray-300 hover:text-white transition-colors"
              >
                Logout
              </button>
            </>
          ) : (
            <>
              <Link
                to="/login"
                className="px-4 py-2 text-sm text-gray-300 hover:text-white transition-colors"
              >
                Sign In
              </Link>
              <Link
                to="/register"
                className="px-4 py-2 text-sm bg-primary-500 text-white rounded hover:bg-primary-600 transition-colors"
              >
                Sign Up
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
