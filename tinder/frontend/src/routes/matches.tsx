import { createFileRoute, Navigate, Link } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useMatchStore } from '../stores/matchStore';
import { useEffect } from 'react';
import BottomNav from '../components/BottomNav';

function MatchesPage() {
  const { isAuthenticated } = useAuthStore();
  const { matches, isLoading, loadMatches } = useMatchStore();

  useEffect(() => {
    if (isAuthenticated) {
      loadMatches();
    }
  }, [isAuthenticated, loadMatches]);

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      {/* Header */}
      <header className="bg-white shadow-sm px-4 py-3">
        <h1 className="text-xl font-bold text-center">Messages</h1>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <div className="w-8 h-8 border-4 border-gradient-start border-t-transparent rounded-full animate-spin" />
          </div>
        ) : matches.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center p-4">
            <div className="w-20 h-20 bg-gray-200 rounded-full flex items-center justify-center mb-4">
              <svg
                className="w-10 h-10 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-gray-700">No matches yet</h2>
            <p className="text-gray-500 mt-2">
              Start swiping to find your match!
            </p>
            <Link to="/" className="btn btn-primary mt-4">
              Start Swiping
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-gray-200">
            {matches.map((match) => (
              <Link
                key={match.id}
                to="/chat/$matchId"
                params={{ matchId: match.id }}
                className="flex items-center p-4 bg-white hover:bg-gray-50 transition-colors"
              >
                <div className="relative">
                  <div className="w-14 h-14 rounded-full bg-gray-200 overflow-hidden">
                    {match.user.primary_photo ? (
                      <img
                        src={match.user.primary_photo}
                        alt={match.user.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-400 text-xl font-bold">
                        {match.user.name[0]}
                      </div>
                    )}
                  </div>
                  {match.unread_count > 0 && (
                    <div className="absolute -top-1 -right-1 w-5 h-5 bg-gradient-start text-white text-xs rounded-full flex items-center justify-center">
                      {match.unread_count}
                    </div>
                  )}
                </div>
                <div className="ml-4 flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-gray-900 truncate">{match.user.name}</h3>
                    {match.last_message_at && (
                      <span className="text-xs text-gray-500">
                        {new Date(match.last_message_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  {match.last_message_preview ? (
                    <p className="text-sm text-gray-500 truncate">{match.last_message_preview}</p>
                  ) : (
                    <p className="text-sm text-gradient-start">New match! Say hi</p>
                  )}
                </div>
                <svg
                  className="w-5 h-5 text-gray-400 ml-2"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </Link>
            ))}
          </div>
        )}
      </main>

      {/* Bottom Navigation */}
      <BottomNav />
    </div>
  );
}

export const Route = createFileRoute('/matches')({
  component: MatchesPage,
});
