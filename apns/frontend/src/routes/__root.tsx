import { createRootRoute, Outlet, Link } from '@tanstack/react-router'
import { useAuthStore } from '../stores/authStore'
import { useEffect } from 'react'

export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  const { isAuthenticated, user, logout, checkAuth, isLoading } = useAuthStore()

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-500">Loading...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {isAuthenticated && (
        <nav className="bg-white shadow-sm border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between h-16">
              <div className="flex">
                <div className="flex-shrink-0 flex items-center">
                  <span className="text-xl font-bold text-primary-600">APNs</span>
                </div>
                <div className="hidden sm:ml-6 sm:flex sm:space-x-8">
                  <Link
                    to="/"
                    className="inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium"
                    activeProps={{
                      className: 'border-primary-500 text-gray-900',
                    }}
                    inactiveProps={{
                      className: 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700',
                    }}
                  >
                    Dashboard
                  </Link>
                  <Link
                    to="/devices"
                    className="inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium"
                    activeProps={{
                      className: 'border-primary-500 text-gray-900',
                    }}
                    inactiveProps={{
                      className: 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700',
                    }}
                  >
                    Devices
                  </Link>
                  <Link
                    to="/notifications"
                    className="inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium"
                    activeProps={{
                      className: 'border-primary-500 text-gray-900',
                    }}
                    inactiveProps={{
                      className: 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700',
                    }}
                  >
                    Notifications
                  </Link>
                  <Link
                    to="/send"
                    className="inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium"
                    activeProps={{
                      className: 'border-primary-500 text-gray-900',
                    }}
                    inactiveProps={{
                      className: 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700',
                    }}
                  >
                    Send Notification
                  </Link>
                </div>
              </div>
              <div className="flex items-center space-x-4">
                <span className="text-sm text-gray-500">
                  {user?.username} ({user?.role})
                </span>
                <button
                  onClick={() => logout()}
                  className="text-sm text-gray-500 hover:text-gray-700"
                >
                  Logout
                </button>
              </div>
            </div>
          </div>
        </nav>
      )}
      <main className={isAuthenticated ? 'max-w-7xl mx-auto py-6 sm:px-6 lg:px-8' : ''}>
        <Outlet />
      </main>
    </div>
  )
}
