/**
 * Driver dashboard page - main interface for receiving and completing rides.
 * Protected route that requires driver authentication.
 */
import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useEffect, useState, useCallback } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useDriverStore } from '../stores/driverStore';

/**
 * Main driver interface for the ride-hailing experience.
 * Provides the complete driver workflow:
 * 1. Go online to start receiving ride offers
 * 2. Accept or decline incoming ride offers (with countdown timer)
 * 3. Navigate to pickup and mark arrival
 * 4. Start trip and complete at dropoff
 *
 * Features real-time location updates and WebSocket-based ride offers.
 *
 * @returns Driver dashboard component
 */
function DriverPage() {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const navigate = useNavigate();

  const {
    isOnline,
    isAvailable,
    currentLocation,
    currentRide,
    rideOffer,
    offerExpiresAt,
    isLoading,
    error,
    setCurrentLocation,
    goOnline,
    goOffline,
    updateLocation,
    fetchStatus,
    acceptRide,
    declineRide,
    arrivedAtPickup,
    startRide,
    completeRide,
    clearError,
  } = useDriverStore();

  const [offerTimeLeft, setOfferTimeLeft] = useState<number | null>(null);

  // Check authentication
  useEffect(() => {
    if (!user || user.userType !== 'driver') {
      navigate({ to: '/login' });
    }
  }, [user, navigate]);

  // Simulate getting current location and updates
  useEffect(() => {
    // In a real app, would use navigator.geolocation.watchPosition
    // For demo, use a fixed location (San Francisco) with slight variations
    const updateLoc = () => {
      const lat = 37.7749 + (Math.random() - 0.5) * 0.01;
      const lng = -122.4194 + (Math.random() - 0.5) * 0.01;
      setCurrentLocation({ lat, lng });
    };

    updateLoc();
    const interval = setInterval(updateLoc, 5000);

    return () => clearInterval(interval);
  }, [setCurrentLocation]);

  // Fetch initial status
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Send location updates when online
  useEffect(() => {
    if (isOnline && currentLocation) {
      const interval = setInterval(() => {
        if (currentLocation) {
          updateLocation(currentLocation.lat, currentLocation.lng);
        }
      }, 3000);

      return () => clearInterval(interval);
    }
  }, [isOnline, currentLocation, updateLocation]);

  // Countdown timer for ride offer
  useEffect(() => {
    if (offerExpiresAt) {
      const interval = setInterval(() => {
        const remaining = Math.max(0, Math.ceil((offerExpiresAt - Date.now()) / 1000));
        setOfferTimeLeft(remaining);

        if (remaining === 0) {
          declineRide();
        }
      }, 100);

      return () => clearInterval(interval);
    } else {
      setOfferTimeLeft(null);
    }
  }, [offerExpiresAt, declineRide]);

  /**
   * Toggle driver online/offline status.
   * Memoized to prevent unnecessary re-renders.
   */
  const handleToggleOnline = useCallback(async () => {
    if (isOnline) {
      await goOffline();
    } else {
      await goOnline();
    }
  }, [isOnline, goOnline, goOffline]);

  /**
   * Log out driver, ensuring they go offline first.
   */
  const handleLogout = async () => {
    if (isOnline) {
      await goOffline();
    }
    await logout();
    navigate({ to: '/' });
  };

  /**
   * Format cents as USD currency string.
   * @param cents - Amount in cents
   * @returns Formatted currency string
   */
  const formatCurrency = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  if (!user) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-black text-white p-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link to="/" className="text-2xl font-bold">Uber Driver</Link>
          <div className="flex items-center gap-4">
            <span className="text-sm">{user.name}</span>
            <button onClick={handleLogout} className="text-sm text-gray-300 hover:text-white">
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-4">
        {error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-600">
            {error}
            <button onClick={clearError} className="ml-2 underline">
              Dismiss
            </button>
          </div>
        )}

        {/* Online/Offline Toggle */}
        <div className="card mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold">
                {isOnline ? (isAvailable ? 'Looking for rides' : 'On a trip') : 'Offline'}
              </h2>
              <p className="text-sm text-gray-600">
                {isOnline
                  ? 'You are visible to riders'
                  : 'Go online to start receiving ride requests'}
              </p>
            </div>
            <button
              onClick={handleToggleOnline}
              disabled={isLoading || !!currentRide}
              className={`px-6 py-3 rounded-full font-medium transition-colors ${
                isOnline
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-green-600 text-white hover:bg-green-700'
              } disabled:opacity-50`}
            >
              {isLoading ? '...' : isOnline ? 'Go Offline' : 'Go Online'}
            </button>
          </div>

          {currentLocation && isOnline && (
            <p className="text-xs text-gray-500 mt-4">
              Location: {currentLocation.lat.toFixed(4)}, {currentLocation.lng.toFixed(4)}
            </p>
          )}
        </div>

        {/* Ride Offer */}
        {rideOffer && (
          <div className="card mb-6 border-2 border-green-500 bg-green-50">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-green-800">New Ride Request!</h2>
              {offerTimeLeft !== null && (
                <span className="text-2xl font-bold text-green-800">{offerTimeLeft}s</span>
              )}
            </div>

            <div className="space-y-3 mb-6">
              <div className="flex justify-between">
                <span className="text-gray-600">Rider</span>
                <span className="font-medium">
                  {rideOffer.rider.name} ({rideOffer.rider.rating.toFixed(1)} ★)
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Pickup ETA</span>
                <span className="font-medium">{rideOffer.etaMinutes} min</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Trip distance</span>
                <span className="font-medium">{rideOffer.distanceKm.toFixed(1)} km</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Estimated fare</span>
                <span className="font-medium text-green-700">
                  {formatCurrency(rideOffer.estimatedFare)}
                </span>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={declineRide}
                className="flex-1 btn btn-secondary py-3"
              >
                Decline
              </button>
              <button
                onClick={acceptRide}
                disabled={isLoading}
                className="flex-1 btn btn-success py-3 disabled:opacity-50"
              >
                {isLoading ? 'Accepting...' : 'Accept'}
              </button>
            </div>
          </div>
        )}

        {/* Current Ride */}
        {currentRide && (
          <div className="card mb-6">
            <h2 className="text-xl font-semibold mb-4">Current Trip</h2>

            <div className="space-y-4">
              {/* Pickup */}
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
                  <span className="text-green-600">P</span>
                </div>
                <div className="flex-1">
                  <p className="text-sm text-gray-500">Pickup</p>
                  <p className="font-medium">
                    {currentRide.pickup.address ||
                      `${currentRide.pickup.lat.toFixed(4)}, ${currentRide.pickup.lng.toFixed(4)}`}
                  </p>
                </div>
              </div>

              {/* Dropoff */}
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 bg-red-100 rounded-full flex items-center justify-center">
                  <span className="text-red-600">D</span>
                </div>
                <div className="flex-1">
                  <p className="text-sm text-gray-500">Dropoff</p>
                  <p className="font-medium">
                    {currentRide.dropoff.address ||
                      `${currentRide.dropoff.lat.toFixed(4)}, ${currentRide.dropoff.lng.toFixed(4)}`}
                  </p>
                </div>
              </div>

              {/* Fare */}
              <div className="pt-4 border-t">
                <div className="flex justify-between">
                  <span className="text-gray-600">Estimated fare</span>
                  <span className="font-semibold">
                    {formatCurrency(currentRide.fare?.estimated || 0)}
                  </span>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="mt-6 space-y-3">
              {currentRide.status === 'matched' && (
                <button
                  onClick={arrivedAtPickup}
                  disabled={isLoading}
                  className="w-full btn btn-primary py-4 disabled:opacity-50"
                >
                  {isLoading ? 'Updating...' : "I've Arrived at Pickup"}
                </button>
              )}

              {currentRide.status === 'driver_arrived' && (
                <button
                  onClick={startRide}
                  disabled={isLoading}
                  className="w-full btn btn-primary py-4 disabled:opacity-50"
                >
                  {isLoading ? 'Starting...' : 'Start Trip'}
                </button>
              )}

              {currentRide.status === 'picked_up' && (
                <button
                  onClick={completeRide}
                  disabled={isLoading}
                  className="w-full btn btn-success py-4 disabled:opacity-50"
                >
                  {isLoading ? 'Completing...' : 'Complete Trip'}
                </button>
              )}

              <p className="text-center text-sm text-gray-500 capitalize">
                Status: {currentRide.status.replace('_', ' ')}
              </p>
            </div>
          </div>
        )}

        {/* Quick Stats */}
        {!currentRide && !rideOffer && isOnline && (
          <div className="card mb-6">
            <h2 className="text-lg font-semibold mb-4">Waiting for rides...</h2>
            <p className="text-gray-600 text-sm">
              Stay in areas with high demand to receive more ride requests.
            </p>
          </div>
        )}

        {/* Links */}
        <div className="flex justify-center gap-8 mt-8">
          <Link to="/driver/earnings" className="text-gray-600 hover:text-black underline">
            Earnings
          </Link>
          <Link to="/driver/history" className="text-gray-600 hover:text-black underline">
            Trip History
          </Link>
        </div>
      </main>
    </div>
  );
}

export const Route = createFileRoute('/driver')({
  component: DriverPage,
});
