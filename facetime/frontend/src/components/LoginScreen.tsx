import type { User } from '../types';

interface LoginScreenProps {
  users: User[];
  onLogin: (username: string) => void;
  isLoading: boolean;
}

export function LoginScreen({ users, onLogin, isLoading }: LoginScreenProps) {
  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6">
      {/* Logo */}
      <div className="mb-8">
        <div className="w-24 h-24 rounded-3xl bg-gradient-to-br from-green-400 to-green-600 flex items-center justify-center shadow-2xl">
          <svg className="w-14 h-14 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </div>
      </div>

      <h1 className="text-3xl font-bold text-white mb-2">FaceTime</h1>
      <p className="text-gray-400 mb-8">Select a user to continue</p>

      {/* User selection */}
      <div className="w-full max-w-md bg-gray-900/50 rounded-2xl p-4 space-y-2">
        {isLoading ? (
          <div className="text-center py-8 text-gray-400">
            Loading users...
          </div>
        ) : users.length === 0 ? (
          <div className="text-center py-8 text-gray-400">
            No users available. Make sure the backend is running.
          </div>
        ) : (
          users.map((user) => (
            <button
              key={user.id}
              onClick={() => onLogin(user.username)}
              className="w-full flex items-center gap-4 p-4 rounded-xl hover:bg-gray-800 transition-colors"
            >
              {/* Avatar */}
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-lg font-semibold text-white">
                {user.avatar_url ? (
                  <img
                    src={user.avatar_url}
                    alt={user.display_name}
                    className="w-full h-full rounded-full object-cover"
                  />
                ) : (
                  user.display_name.charAt(0).toUpperCase()
                )}
              </div>

              {/* Name */}
              <div className="text-left">
                <p className="text-white font-medium">{user.display_name}</p>
                <p className="text-sm text-gray-400">@{user.username}</p>
              </div>

              {/* Arrow */}
              <svg className="w-5 h-5 text-gray-400 ml-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ))
        )}
      </div>

      {/* Info */}
      <p className="text-sm text-gray-500 mt-8 text-center max-w-md">
        This is a demo app. Select any user to simulate their session.
        Open multiple browser windows to test calling between users.
      </p>
    </div>
  );
}
