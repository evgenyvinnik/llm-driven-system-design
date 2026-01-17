import { Link } from '@tanstack/react-router';
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
    <nav className="bg-strava-gray-800 text-white">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center space-x-8">
            <Link to="/" className="text-xl font-bold text-strava-orange">
              Strava
            </Link>

            <div className="hidden md:flex items-center space-x-4">
              <Link
                to="/"
                className="px-3 py-2 rounded-md text-sm font-medium hover:bg-strava-gray-700 [&.active]:bg-strava-gray-700"
              >
                Dashboard
              </Link>
              <Link
                to="/explore"
                className="px-3 py-2 rounded-md text-sm font-medium hover:bg-strava-gray-700 [&.active]:bg-strava-gray-700"
              >
                Explore
              </Link>
              <Link
                to="/segments"
                className="px-3 py-2 rounded-md text-sm font-medium hover:bg-strava-gray-700 [&.active]:bg-strava-gray-700"
              >
                Segments
              </Link>
              {isAuthenticated && (
                <Link
                  to="/upload"
                  className="px-3 py-2 rounded-md text-sm font-medium hover:bg-strava-gray-700 [&.active]:bg-strava-gray-700"
                >
                  Upload
                </Link>
              )}
            </div>
          </div>

          <div className="flex items-center space-x-4">
            {isAuthenticated ? (
              <>
                <Link
                  to="/stats"
                  className="px-3 py-2 rounded-md text-sm font-medium hover:bg-strava-gray-700"
                >
                  My Stats
                </Link>
                <Link
                  to={`/profile/${user?.id}`}
                  className="flex items-center px-3 py-2 rounded-md text-sm font-medium hover:bg-strava-gray-700"
                >
                  <div className="w-8 h-8 bg-strava-orange rounded-full flex items-center justify-center text-white font-bold mr-2">
                    {user?.username?.charAt(0).toUpperCase()}
                  </div>
                  {user?.username}
                </Link>
                <button
                  onClick={handleLogout}
                  className="px-3 py-2 rounded-md text-sm font-medium hover:bg-strava-gray-700"
                >
                  Logout
                </button>
              </>
            ) : (
              <>
                <Link
                  to="/login"
                  className="px-3 py-2 rounded-md text-sm font-medium hover:bg-strava-gray-700"
                >
                  Log In
                </Link>
                <Link
                  to="/register"
                  className="px-4 py-2 bg-strava-orange rounded-md text-sm font-medium hover:bg-strava-orange-dark"
                >
                  Sign Up
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
