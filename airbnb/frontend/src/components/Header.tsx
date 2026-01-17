import { Link } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useState } from 'react';

export function Header() {
  const { user, isAuthenticated, logout } = useAuthStore();
  const [showMenu, setShowMenu] = useState(false);

  return (
    <header className="sticky top-0 z-50 bg-white border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-20">
          {/* Logo */}
          <Link to="/" className="flex items-center">
            <svg
              viewBox="0 0 32 32"
              className="w-8 h-8 text-airbnb"
              fill="currentColor"
            >
              <path d="M16 1c2.008 0 3.463.963 4.751 3.269l.533 1.025c1.954 3.83 6.114 12.54 7.1 14.836l.145.353c.667 1.591.91 2.472.91 3.517 0 2.716-1.746 5-4.5 5a5.25 5.25 0 01-3.694-1.508l-.25-.246c-.678-.692-1.568-1.79-2.833-3.46l-.077-.103c-.07-.093-.139-.185-.207-.276l-.089-.119-.074-.099-.075-.097-.073-.094-.072-.092-.071-.09-.069-.088-.068-.085-.067-.084-.065-.082-.064-.08-.063-.078-.061-.076-.06-.073-.058-.071-.057-.068-.055-.066-.054-.064-.052-.061-.05-.058-.049-.056-.047-.053-.045-.051-.044-.049-.042-.046-.04-.043-.038-.041-.037-.039-.035-.036-.033-.034-.03-.031-.027-.028-.019-.02a.5.5 0 01.036-.722l.02-.019.028-.027.031-.03.034-.033.036-.035.039-.037.041-.038.043-.04.046-.042.049-.044.051-.045.053-.047.056-.049.058-.05.061-.052.064-.054.066-.055.068-.057.071-.058.073-.06.076-.061.078-.063.08-.064.082-.065.084-.067.085-.068.088-.069.09-.071.092-.072.094-.073.097-.075.099-.074.119-.089.276-.207.103-.077c1.67-1.265 2.768-2.155 3.46-2.833l.246-.25A5.25 5.25 0 0120.5 9.5c0-.918-.268-1.728-.797-2.432l-.118-.144-.08-.092c-.4-.428-.85-.737-1.408-.937l-.177-.056a3.5 3.5 0 00-3.84.993l-.118.144-.08.092c-.4.428-.85.737-1.408.937l-.177.056a3.5 3.5 0 00-3.84-.993l-.118.144-.08.092c-.4.428-.85.737-1.408.937l-.177.056c-.918.268-1.728.797-2.432 1.325l-.144.118-.092.08c-.428.4-.737.85-.937 1.408l-.056.177a3.5 3.5 0 00.993 3.84l.144.118.092.08c.428.4.737.85.937 1.408l.056.177c.268.918.797 1.728 1.325 2.432l.118.144.08.092c.4.428.85.737 1.408.937l.177.056a3.5 3.5 0 003.84-.993l.118-.144.08-.092c.4-.428.85-.737 1.408-.937l.177-.056a3.5 3.5 0 003.84.993l.118-.144.08-.092c.4-.428.85-.737 1.408-.937l.177-.056c.918-.268 1.728-.797 2.432-1.325l.144-.118.092-.08c.428-.4.737-.85.937-1.408l.056-.177a3.5 3.5 0 00-.993-3.84z" />
            </svg>
            <span className="ml-2 text-xl font-bold text-airbnb hidden sm:block">
              airbnb
            </span>
          </Link>

          {/* Navigation */}
          <nav className="hidden md:flex items-center space-x-6">
            <Link
              to="/search"
              className="text-gray-600 hover:text-gray-900 font-medium"
            >
              Explore
            </Link>
            {isAuthenticated && user?.is_host && (
              <Link
                to="/host/listings"
                className="text-gray-600 hover:text-gray-900 font-medium"
              >
                Host Dashboard
              </Link>
            )}
          </nav>

          {/* User Menu */}
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="flex items-center space-x-2 border border-gray-300 rounded-full p-2 hover:shadow-md transition-shadow"
            >
              <svg
                className="w-5 h-5 text-gray-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 6h16M4 12h16M4 18h16"
                />
              </svg>
              <div className="w-8 h-8 bg-gray-500 rounded-full flex items-center justify-center">
                {user?.avatar_url ? (
                  <img
                    src={user.avatar_url}
                    alt={user.name}
                    className="w-full h-full rounded-full object-cover"
                  />
                ) : (
                  <svg
                    className="w-5 h-5 text-white"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                  </svg>
                )}
              </div>
            </button>

            {showMenu && (
              <div className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-lg border border-gray-200 py-2 z-50">
                {isAuthenticated ? (
                  <>
                    <div className="px-4 py-2 border-b border-gray-100">
                      <p className="font-medium">{user?.name}</p>
                      <p className="text-sm text-gray-500">{user?.email}</p>
                    </div>
                    <Link
                      to="/trips"
                      className="block px-4 py-2 hover:bg-gray-50"
                      onClick={() => setShowMenu(false)}
                    >
                      My Trips
                    </Link>
                    <Link
                      to="/messages"
                      className="block px-4 py-2 hover:bg-gray-50"
                      onClick={() => setShowMenu(false)}
                    >
                      Messages
                    </Link>
                    {user?.is_host ? (
                      <>
                        <Link
                          to="/host/listings"
                          className="block px-4 py-2 hover:bg-gray-50"
                          onClick={() => setShowMenu(false)}
                        >
                          My Listings
                        </Link>
                        <Link
                          to="/host/reservations"
                          className="block px-4 py-2 hover:bg-gray-50"
                          onClick={() => setShowMenu(false)}
                        >
                          Reservations
                        </Link>
                      </>
                    ) : (
                      <Link
                        to="/become-host"
                        className="block px-4 py-2 hover:bg-gray-50"
                        onClick={() => setShowMenu(false)}
                      >
                        Become a Host
                      </Link>
                    )}
                    <div className="border-t border-gray-100 mt-2 pt-2">
                      <button
                        onClick={() => {
                          logout();
                          setShowMenu(false);
                        }}
                        className="w-full text-left px-4 py-2 hover:bg-gray-50 text-red-600"
                      >
                        Log out
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <Link
                      to="/login"
                      className="block px-4 py-2 hover:bg-gray-50 font-medium"
                      onClick={() => setShowMenu(false)}
                    >
                      Log in
                    </Link>
                    <Link
                      to="/register"
                      className="block px-4 py-2 hover:bg-gray-50"
                      onClick={() => setShowMenu(false)}
                    >
                      Sign up
                    </Link>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
