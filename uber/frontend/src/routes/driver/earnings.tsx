import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { useDriverStore } from '../../stores/driverStore';

function DriverEarningsPage() {
  const user = useAuthStore((state) => state.user);
  const navigate = useNavigate();
  const { earnings, fetchEarnings, isLoading } = useDriverStore();
  const [period, setPeriod] = useState('today');

  useEffect(() => {
    if (!user || user.userType !== 'driver') {
      navigate({ to: '/login' });
      return;
    }

    fetchEarnings(period);
  }, [user, navigate, fetchEarnings, period]);

  const formatCurrency = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  if (!user) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-black text-white p-4">
        <div className="max-w-4xl mx-auto flex items-center gap-4">
          <Link to="/driver" className="text-gray-400 hover:text-white">
            ← Back
          </Link>
          <h1 className="text-xl font-bold">Earnings</h1>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-4">
        {/* Period Selector */}
        <div className="flex gap-2 mb-6">
          {['today', 'week', 'month'].map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`flex-1 py-2 rounded-lg font-medium capitalize transition-colors ${
                period === p
                  ? 'bg-black text-white'
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="text-center py-8">
            <p className="text-gray-600">Loading earnings...</p>
          </div>
        ) : earnings ? (
          <>
            {/* Summary */}
            <div className="card mb-6 text-center">
              <p className="text-sm text-gray-600 mb-2">Total Earnings</p>
              <p className="text-4xl font-bold">{formatCurrency(earnings.totalEarnings)}</p>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="card text-center">
                <p className="text-2xl font-semibold">{earnings.totalRides}</p>
                <p className="text-sm text-gray-600">Rides</p>
              </div>
              <div className="card text-center">
                <p className="text-2xl font-semibold">{formatCurrency(earnings.averageFare)}</p>
                <p className="text-sm text-gray-600">Avg. Fare</p>
              </div>
              <div className="card text-center">
                <p className="text-2xl font-semibold">{earnings.totalDistanceKm} km</p>
                <p className="text-sm text-gray-600">Distance</p>
              </div>
              <div className="card text-center">
                <p className="text-2xl font-semibold">{earnings.totalHours} hrs</p>
                <p className="text-sm text-gray-600">Online Time</p>
              </div>
            </div>

            {/* Hourly Breakdown */}
            {earnings.hourlyBreakdown.length > 0 && (
              <div className="card">
                <h3 className="font-semibold mb-4">Hourly Breakdown</h3>
                <div className="space-y-2">
                  {earnings.hourlyBreakdown.map((hour, index) => (
                    <div key={index} className="flex justify-between text-sm">
                      <span className="text-gray-600">
                        {new Date(hour.hour).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      <span>
                        {hour.rides} rides · {formatCurrency(hour.earnings)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="text-center py-12">
            <p className="text-gray-600">No earnings data available</p>
          </div>
        )}
      </main>
    </div>
  );
}

export const Route = createFileRoute('/driver/earnings')({
  component: DriverEarningsPage,
});
