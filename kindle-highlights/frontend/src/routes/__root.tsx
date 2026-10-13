/**
 * Root layout component
 * @module routes/__root
 */
import { createRootRoute, Outlet, Link } from '@tanstack/react-router'
import { useStore } from '@/stores/useStore'
import { logout as revokeSession } from '@/api/client'
import { clearOutbox } from '@/sync/outbox'
import { useSyncChannel } from '@/sync/useSyncChannel'

/**
 * Root route component that provides the main layout
 */
export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  const { isAuthenticated, user, logout } = useStore()
  useSyncChannel()

  const handleLogout = () => {
    clearOutbox()
    void revokeSession()
    logout()
  }

  return (
    <div className="min-h-screen bg-kindle-cream">
      <header className="border-b border-gray-200 bg-white shadow-sm">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-xl font-semibold text-gray-900">
            📚 Kindle Highlights
          </Link>

          <div className="flex items-center gap-6">
            {isAuthenticated ? (
              <>
                <Link
                  to="/library"
                  className="text-gray-600 hover:text-gray-900"
                  activeProps={{ className: 'text-gray-900 font-medium' }}
                >
                  My Library
                </Link>
                <Link
                  to="/trending"
                  className="text-gray-600 hover:text-gray-900"
                  activeProps={{ className: 'text-gray-900 font-medium' }}
                >
                  Trending
                </Link>
                <Link
                  to="/export"
                  className="text-gray-600 hover:text-gray-900"
                  activeProps={{ className: 'text-gray-900 font-medium' }}
                >
                  Export
                </Link>
                <div className="flex items-center gap-3">
                  <SyncStatus />
                  <span className="text-sm text-gray-600">
                    Hello, {user?.username}
                  </span>
                  <button
                    onClick={handleLogout}
                    className="rounded-md bg-gray-100 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-200"
                  >
                    Logout
                  </button>
                </div>
              </>
            ) : (
              <>
                <Link
                  to="/login"
                  className="text-gray-600 hover:text-gray-900"
                >
                  Login
                </Link>
                <Link
                  to="/register"
                  className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
                >
                  Sign Up
                </Link>
              </>
            )}
          </div>
        </nav>
      </header>

      <main>
        <Outlet />
      </main>

      <footer className="border-t border-gray-200 bg-white py-6 text-center text-sm text-gray-500">
        <p>Kindle Highlights - A social reading platform</p>
      </footer>
    </div>
  )
}

/** Connection and outbox state, announced politely to screen readers when it changes. */
function SyncStatus() {
  const syncStatus = useStore((state) => state.syncStatus)
  const pendingOps = useStore((state) => state.pendingOps)

  const label =
    syncStatus === 'live'
      ? pendingOps > 0
        ? `Syncing ${pendingOps} change${pendingOps === 1 ? '' : 's'}`
        : 'Synced'
      : syncStatus === 'connecting'
        ? 'Connecting'
        : pendingOps > 0
          ? `Offline: ${pendingOps} change${pendingOps === 1 ? '' : 's'} waiting`
          : 'Offline'
  const dot = syncStatus === 'live' ? 'bg-green-500' : syncStatus === 'connecting' ? 'bg-yellow-400' : 'bg-gray-400'

  return (
    <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-xs text-gray-500">
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  )
}
