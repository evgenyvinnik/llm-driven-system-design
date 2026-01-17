import { createRootRoute, Outlet, Link, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useAuthStore } from '../stores/authStore'

function RootComponent() {
  const { user, isAuthenticated, isLoading, checkAuth, logout } = useAuthStore()
  const navigate = useNavigate()

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  const handleLogout = async () => {
    await logout()
    navigate({ to: '/login' })
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center space-x-8">
              <Link to="/" className="flex items-center space-x-2">
                <svg className="w-8 h-8 text-docusign-blue" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                <span className="text-xl font-bold text-gray-900">DocuSign</span>
              </Link>

              {isAuthenticated && (
                <nav className="hidden md:flex space-x-6">
                  <Link
                    to="/"
                    className="text-gray-600 hover:text-gray-900 px-3 py-2 text-sm font-medium"
                    activeProps={{ className: 'text-docusign-blue' }}
                  >
                    Dashboard
                  </Link>
                  <Link
                    to="/envelopes"
                    className="text-gray-600 hover:text-gray-900 px-3 py-2 text-sm font-medium"
                    activeProps={{ className: 'text-docusign-blue' }}
                  >
                    Envelopes
                  </Link>
                  {user?.role === 'admin' && (
                    <Link
                      to="/admin"
                      className="text-gray-600 hover:text-gray-900 px-3 py-2 text-sm font-medium"
                      activeProps={{ className: 'text-docusign-blue' }}
                    >
                      Admin
                    </Link>
                  )}
                </nav>
              )}
            </div>

            <div className="flex items-center space-x-4">
              {isLoading ? (
                <div className="w-6 h-6 border-2 border-gray-300 border-t-docusign-blue rounded-full spinner" />
              ) : isAuthenticated ? (
                <>
                  <span className="text-sm text-gray-600">{user?.email}</span>
                  <button
                    onClick={handleLogout}
                    className="text-sm text-gray-600 hover:text-gray-900"
                  >
                    Logout
                  </button>
                </>
              ) : (
                <>
                  <Link to="/login" className="text-sm text-gray-600 hover:text-gray-900">
                    Login
                  </Link>
                  <Link
                    to="/register"
                    className="bg-docusign-blue text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-docusign-dark"
                  >
                    Sign Up
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main>
        <Outlet />
      </main>
    </div>
  )
}

export const Route = createRootRoute({
  component: RootComponent,
})
