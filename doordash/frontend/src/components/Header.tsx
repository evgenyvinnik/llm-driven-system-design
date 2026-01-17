import { Link, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useCartStore } from '../stores/cartStore';

export function Header() {
  const { user, logout } = useAuthStore();
  const itemCount = useCartStore((s) => s.itemCount());
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/' });
  };

  return (
    <header className="bg-white shadow-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2">
          <div className="w-8 h-8 bg-doordash-red rounded-full flex items-center justify-center">
            <span className="text-white font-bold text-lg">D</span>
          </div>
          <span className="text-xl font-bold text-gray-900">DoorDash</span>
        </Link>

        <nav className="flex items-center gap-4">
          {user ? (
            <>
              {user.role === 'customer' && (
                <>
                  <Link
                    to="/"
                    className="text-gray-600 hover:text-gray-900 font-medium"
                  >
                    Restaurants
                  </Link>
                  <Link
                    to="/orders"
                    className="text-gray-600 hover:text-gray-900 font-medium"
                  >
                    Orders
                  </Link>
                  <Link
                    to="/cart"
                    className="relative text-gray-600 hover:text-gray-900"
                  >
                    <svg
                      className="w-6 h-6"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z"
                      />
                    </svg>
                    {itemCount > 0 && (
                      <span className="absolute -top-2 -right-2 bg-doordash-red text-white text-xs w-5 h-5 rounded-full flex items-center justify-center">
                        {itemCount}
                      </span>
                    )}
                  </Link>
                </>
              )}
              {user.role === 'restaurant_owner' && (
                <Link
                  to="/restaurant-dashboard"
                  className="text-gray-600 hover:text-gray-900 font-medium"
                >
                  Dashboard
                </Link>
              )}
              {user.role === 'driver' && (
                <Link
                  to="/driver-dashboard"
                  className="text-gray-600 hover:text-gray-900 font-medium"
                >
                  Dashboard
                </Link>
              )}
              <div className="flex items-center gap-3 ml-4">
                <span className="text-sm text-gray-500">
                  Hi, {user.name.split(' ')[0]}
                </span>
                <button
                  onClick={handleLogout}
                  className="text-sm text-gray-600 hover:text-gray-900"
                >
                  Logout
                </button>
              </div>
            </>
          ) : (
            <>
              <Link
                to="/login"
                className="text-gray-600 hover:text-gray-900 font-medium"
              >
                Log in
              </Link>
              <Link
                to="/register"
                className="bg-doordash-red text-white px-4 py-2 rounded-full font-medium hover:bg-doordash-darkRed transition"
              >
                Sign up
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
