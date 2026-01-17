import { useAuthStore } from '../stores/auth';

export function Header() {
  const { user, logout } = useAuthStore();

  return (
    <header className="bg-white shadow">
      <div className="container mx-auto px-4 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <h1 className="text-xl font-bold text-gray-900">Scalable API</h1>
          <span className="px-2 py-1 bg-primary-100 text-primary-700 text-sm rounded-md">
            Admin Dashboard
          </span>
        </div>

        <div className="flex items-center space-x-4">
          {user && (
            <>
              <span className="text-sm text-gray-600">
                {user.email}
                <span className="ml-2 px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded-full">
                  {user.role}
                </span>
              </span>
              <button onClick={logout} className="btn btn-secondary text-sm">
                Logout
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
