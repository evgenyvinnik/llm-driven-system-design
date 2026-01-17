/**
 * Driver trip history page - displays past trips completed by the driver.
 * Protected route that requires driver authentication.
 */
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import api from '../../services/api';

/**
 * Trip history item structure for display.
 */
interface TripHistoryItem {
  id: string;
  status: string;
  pickup: { lat: number; lng: number; address?: string };
  dropoff: { lat: number; lng: number; address?: string };
  vehicleType: string;
  fare: number;
  surgeMultiplier: number;
  rider?: { name: string };
  requestedAt: string;
  completedAt?: string;
}

/**
 * Trip history page showing past rides completed by the driver.
 * Displays trip details including pickup/dropoff, rider info, fare earned, and status.
 *
 * @returns Driver history page component
 */
function DriverHistoryPage() {
  const user = useAuthStore((state) => state.user);
  const navigate = useNavigate();
  const [trips, setTrips] = useState<TripHistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!user || user.userType !== 'driver') {
      navigate({ to: '/login' });
      return;
    }

    const fetchHistory = async () => {
      try {
        const result = await api.rides.history(50, 0);
        setTrips(result.rides as TripHistoryItem[]);
      } catch (error) {
        console.error('Failed to fetch trip history:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchHistory();
  }, [user, navigate]);

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
          <Link to="/driver" className="text-gray-400 hover:text-white">
            ← Back
          </Link>
          <h1 className="text-xl font-bold">Trip History</h1>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-4">
        {isLoading ? (
          <div className="text-center py-8">
            <p className="text-gray-600">Loading trips...</p>
          </div>
        ) : trips.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-600">No trips yet</p>
            <Link to="/driver" className="text-black underline mt-4 inline-block">
              Go online to start driving
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            {trips.map((trip) => (
              <div key={trip.id} className="card">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm text-gray-500">{formatDate(trip.requestedAt)}</p>
                    <p className="font-medium mt-1">
                      {trip.pickup.address || 'Pickup'} → {trip.dropoff.address || 'Dropoff'}
                    </p>
                    {trip.rider && (
                      <p className="text-sm text-gray-600 mt-1">Rider: {trip.rider.name}</p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-green-600">{formatCurrency(trip.fare)}</p>
                    <p
                      className={`text-xs mt-1 ${
                        trip.status === 'completed'
                          ? 'text-green-600'
                          : trip.status === 'cancelled'
                            ? 'text-red-600'
                            : 'text-gray-600'
                      }`}
                    >
                      {trip.status}
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

export const Route = createFileRoute('/driver/history')({
  component: DriverHistoryPage,
});
