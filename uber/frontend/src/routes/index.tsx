import { createFileRoute, Link } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';

function IndexPage() {
  const user = useAuthStore((state) => state.user);

  if (user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-2">Welcome back, {user.name}</h1>
          <p className="text-gray-600">You are logged in as a {user.userType}</p>
        </div>

        <div className="flex gap-4">
          {user.userType === 'rider' ? (
            <Link to="/rider" className="btn btn-primary px-8 py-4 text-lg">
              Open Rider App
            </Link>
          ) : (
            <Link to="/driver" className="btn btn-primary px-8 py-4 text-lg">
              Open Driver App
            </Link>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-black text-white">
      <div className="text-center mb-12">
        <h1 className="text-6xl font-bold mb-4">Uber</h1>
        <p className="text-xl text-gray-400">Ride-hailing platform</p>
      </div>

      <div className="flex flex-col gap-4 w-full max-w-xs">
        <Link
          to="/login"
          className="w-full py-4 text-center bg-white text-black rounded-lg font-medium hover:bg-gray-100 transition-colors"
        >
          Sign In
        </Link>
        <Link
          to="/register"
          className="w-full py-4 text-center bg-gray-800 text-white rounded-lg font-medium hover:bg-gray-700 transition-colors"
        >
          Create Account
        </Link>
      </div>

      <div className="mt-12 text-center text-gray-500">
        <p className="text-sm">Demo credentials:</p>
        <p className="text-xs mt-1">Rider: rider1@test.com / password123</p>
        <p className="text-xs">Driver: driver1@test.com / password123</p>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/')({
  component: IndexPage,
});
