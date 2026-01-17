import { LeaderboardEntry } from '../types';
import { formatDuration } from '../utils/format';

interface LeaderboardTableProps {
  entries: LeaderboardEntry[];
  currentUserId?: string;
}

export function LeaderboardTable({ entries, currentUserId }: LeaderboardTableProps) {
  if (entries.length === 0) {
    return (
      <div className="text-center py-8 text-strava-gray-500">
        No efforts recorded yet. Be the first!
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-strava-gray-200">
            <th className="text-left py-2 px-3 text-xs font-medium text-strava-gray-500 uppercase">
              Rank
            </th>
            <th className="text-left py-2 px-3 text-xs font-medium text-strava-gray-500 uppercase">
              Athlete
            </th>
            <th className="text-right py-2 px-3 text-xs font-medium text-strava-gray-500 uppercase">
              Time
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const isCurrentUser = entry.user.id === currentUserId;
            return (
              <tr
                key={entry.userId}
                className={`border-b border-strava-gray-100 ${
                  isCurrentUser ? 'bg-strava-orange bg-opacity-10' : ''
                }`}
              >
                <td className="py-3 px-3">
                  <span
                    className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-sm font-bold ${
                      entry.rank === 1
                        ? 'bg-yellow-400 text-yellow-900'
                        : entry.rank === 2
                        ? 'bg-gray-300 text-gray-700'
                        : entry.rank === 3
                        ? 'bg-amber-600 text-white'
                        : 'bg-strava-gray-100 text-strava-gray-600'
                    }`}
                  >
                    {entry.rank}
                  </span>
                </td>
                <td className="py-3 px-3">
                  <div className="flex items-center">
                    <div className="w-8 h-8 bg-strava-gray-200 rounded-full flex items-center justify-center text-sm font-bold">
                      {entry.user.profile_photo ? (
                        <img
                          src={entry.user.profile_photo}
                          alt={entry.user.username}
                          className="w-8 h-8 rounded-full"
                        />
                      ) : (
                        entry.user.username.charAt(0).toUpperCase()
                      )}
                    </div>
                    <span className={`ml-3 ${isCurrentUser ? 'font-semibold' : ''}`}>
                      {entry.user.username}
                      {isCurrentUser && ' (You)'}
                    </span>
                  </div>
                </td>
                <td className="py-3 px-3 text-right font-mono font-semibold">
                  {formatDuration(entry.elapsedTime)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
