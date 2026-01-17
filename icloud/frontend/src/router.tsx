import { createRootRoute, createRoute, createRouter, Outlet, Link, redirect } from '@tanstack/react-router';
import { useAuthStore } from './stores/authStore';
import { CloudIcon } from './components/Icons';

// Root layout
const RootLayout = () => {
  const { user, logout } = useAuthStore();

  return (
    <div className="min-h-screen bg-gray-50">
      {user && (
        <header className="bg-white border-b sticky top-0 z-40">
          <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
            <div className="flex items-center gap-6">
              <Link to="/" className="flex items-center gap-2">
                <CloudIcon className="w-8 h-8" />
                <span className="font-semibold text-lg">iCloud</span>
              </Link>

              <nav className="flex items-center gap-4">
                <Link
                  to="/drive"
                  className="text-gray-600 hover:text-gray-900 [&.active]:text-blue-600 [&.active]:font-medium"
                >
                  Drive
                </Link>
                <Link
                  to="/photos"
                  className="text-gray-600 hover:text-gray-900 [&.active]:text-blue-600 [&.active]:font-medium"
                >
                  Photos
                </Link>
                {user.role === 'admin' && (
                  <Link
                    to="/admin"
                    className="text-gray-600 hover:text-gray-900 [&.active]:text-blue-600 [&.active]:font-medium"
                  >
                    Admin
                  </Link>
                )}
              </nav>
            </div>

            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-500">{user.email}</span>
              <button
                onClick={() => logout()}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Sign Out
              </button>
            </div>
          </div>
        </header>
      )}

      <main className={user ? 'max-w-7xl mx-auto' : ''}>
        <Outlet />
      </main>
    </div>
  );
};

// Create root route
export const rootRoute = createRootRoute({
  component: RootLayout,
});

// Index route - redirect to drive or login
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    const { user } = useAuthStore.getState();
    if (user) {
      throw redirect({ to: '/drive' });
    }
    throw redirect({ to: '/login' });
  },
  component: () => null,
});

// Login route
import { LoginPage } from './routes/LoginPage';
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

// Register route
import { RegisterPage } from './routes/RegisterPage';
const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  component: RegisterPage,
});

// Protected route wrapper
const protectedBeforeLoad = () => {
  const { user, isLoading } = useAuthStore.getState();
  if (!user && !isLoading) {
    throw redirect({ to: '/login' });
  }
};

// Drive route
import { DrivePage } from './routes/DrivePage';
const driveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/drive',
  beforeLoad: protectedBeforeLoad,
  component: DrivePage,
});

// Photos route
import { PhotosPage } from './routes/PhotosPage';
const photosRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/photos',
  beforeLoad: protectedBeforeLoad,
  component: PhotosPage,
});

// Admin route
import { AdminPage } from './routes/AdminPage';
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  beforeLoad: () => {
    const { user } = useAuthStore.getState();
    if (!user) {
      throw redirect({ to: '/login' });
    }
    if (user.role !== 'admin') {
      throw redirect({ to: '/drive' });
    }
  },
  component: AdminPage,
});

// Create route tree
const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  registerRoute,
  driveRoute,
  photosRoute,
  adminRoute,
]);

// Create router
export const router = createRouter({ routeTree });

// Type declarations
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
