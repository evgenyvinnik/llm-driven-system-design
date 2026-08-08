/**
 * Rider ride history page - displays past rides for the current rider.
 * Protected route that requires rider authentication.
 */
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import api from '../../services/api';

/**
 * Ride history item structure for display.
 */
interface RideHistoryItem {
  id: string;
  status: string;
  pickup: { lat: number; lng: number; address?: string };
  dropoff: { lat: number; lng: number; address?: string };
  vehicleType: string;
  fare: number;
  surgeMultiplier: number;
  driver?: { name: string; vehicle: string };
  requestedAt: string;
  completedAt?: string;
}

/**
 * Ride history page showing past rides for the current rider.
 * Displays ride details including pickup/dropoff, driver info, fare, and status.
 *
 * @returns Rider history page component
 */
function RiderHistoryPage() {
  const user = useAuthStore((state) => state.user);
  const authResolved = useAuthStore((state) => state.authResolved);
  const navigate = useNavigate();
  const [rides, setRides] = useState<RideHistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Only the token is persisted, so `user` is null on every page load until
    // checkAuth resolves. Redirecting before then bounces authenticated
    // users to /login on any reload or deep link.
    if (!authResolved) return;
    if (!user || user.userType !== 'rider') {
      navigate({ to: '/login' });
      return;
    }

    const fetchHistory = async () => {
      try {
        const result = await api.rides.history(50, 0);
        setRides(result.rides as RideHistoryItem[]);
      } catch (error) {
        console.error('Failed to fetch ride history:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchHistory();
  }, [user, authResolved, navigate]);

  /**
   * Format cents as USD currency string.
   * @param cents - Amount in cents
   * @returns Formatted currency string
   */
  const formatCurrency = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  /**
   * Format ISO date string as localized date.
   * @param dateStr - ISO date string
   * @returns Localized date string
   */
  const formatDate = (dateStr: string) => new Date(dateStr).toLocaleDateString();

  if (!user) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-black text-white p-4">
        <div className="max-w-4xl mx-auto flex items-center gap-4">
          <Link to="/rider" className="text-gray-400 hover:text-white">
            ← Back
          </Link>
          <h1 className="text-xl font-bold">Ride History</h1>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-4">
        {isLoading ? (
          <div className="text-center py-8">
            <p className="text-gray-600">Loading rides...</p>
          </div>
        ) : rides.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-600">No rides yet</p>
            <Link to="/rider" className="text-black underline mt-4 inline-block">
              Book your first ride
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            {rides.map((ride) => (
              <div key={ride.id} className="card">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm text-gray-500">{formatDate(ride.requestedAt)}</p>
                    <p className="font-medium mt-1">
                      {ride.pickup.address || 'Pickup'} → {ride.dropoff.address || 'Dropoff'}
                    </p>
                    {ride.driver && (
                      <p className="text-sm text-gray-600 mt-1">
                        {ride.driver.name} · {ride.driver.vehicle}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="font-semibold">{formatCurrency(ride.fare)}</p>
                    <p
                      className={`text-xs mt-1 ${
                        ride.status === 'completed'
                          ? 'text-green-600'
                          : ride.status === 'cancelled'
                            ? 'text-red-600'
                            : 'text-gray-600'
                      }`}
                    >
                      {ride.status}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

export const Route = createFileRoute('/rider/history')({
  component: RiderHistoryPage,
});
