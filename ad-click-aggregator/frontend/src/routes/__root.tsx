import { createRootRoute, Outlet } from '@tanstack/react-router'
import { Navigation } from '../components/Navigation'

export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  return (
    <div className="min-h-screen bg-gray-100">
      <Navigation />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  )
}
