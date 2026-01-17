import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useRideStore } from '../stores/rideStore';
import { FareEstimate } from '../types';

function RiderPage() {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const navigate = useNavigate();

  const {
    pickup,
    dropoff,
    estimates,
    selectedVehicleType,
    currentRide,
    rideStatus,
    isLoading,
    error,
    setPickup,
    setDropoff,
    setSelectedVehicleType,
    fetchEstimates,
    requestRide,
    cancelRide,
    rateRide,
    clearRide,
    clearError,
    setCurrentLocation,
  } = useRideStore();

  const [pickupInput, setPickupInput] = useState('');
  const [dropoffInput, setDropoffInput] = useState('');
  const [rating, setRating] = useState(5);

  // Check authentication
  useEffect(() => {
    if (!user || user.userType !== 'rider') {
      navigate({ to: '/login' });
    }
  }, [user, navigate]);

  // Simulate getting current location
  useEffect(() => {
    // In a real app, would use navigator.geolocation
    // For demo, use a fixed location (San Francisco)
    setCurrentLocation({ lat: 37.7749, lng: -122.4194 });
  }, [setCurrentLocation]);

  // Simulate location search (in real app, would use geocoding API)
  const handleSetPickup = () => {
    if (pickupInput) {
      // Random location near SF
      const lat = 37.7749 + (Math.random() - 0.5) * 0.05;
      const lng = -122.4194 + (Math.random() - 0.5) * 0.05;
      setPickup({ lat, lng, address: pickupInput });
    }
  };

  const handleSetDropoff = () => {
    if (dropoffInput) {
      // Random location near SF
      const lat = 37.7749 + (Math.random() - 0.5) * 0.1;
      const lng = -122.4194 + (Math.random() - 0.5) * 0.1;
      setDropoff({ lat, lng, address: dropoffInput });
    }
  };

  // Fetch estimates when both locations are set
  useEffect(() => {
    if (pickup && dropoff && !currentRide) {
      fetchEstimates();
    }
  }, [pickup, dropoff, currentRide, fetchEstimates]);

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/' });
  };

  const formatCurrency = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  const getVehicleIcon = (type: string) => {
    switch (type) {
      case 'economy':
        return '🚗';
      case 'comfort':
        return '🚙';
      case 'premium':
        return '🚘';
      case 'xl':
        return '🚐';
      default:
        return '🚗';
    }
  };

  if (!user) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-black text-white p-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link to="/" className="text-2xl font-bold">Uber</Link>
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

        {/* Active Ride Status */}
        {currentRide && rideStatus && rideStatus !== 'completed' && (
          <div className="card mb-6">
            <h2 className="text-xl font-semibold mb-4">Your Ride</h2>

            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-gray-600">Status</span>
                <span
                  className={`px-3 py-1 rounded-full text-sm font-medium ${
                    rideStatus === 'requested'
                      ? 'bg-yellow-100 text-yellow-800'
                      : rideStatus === 'matched'
                        ? 'bg-blue-100 text-blue-800'
                        : rideStatus === 'driver_arrived'
                          ? 'bg-green-100 text-green-800'
                          : 'bg-purple-100 text-purple-800'
                  }`}
                >
                  {rideStatus === 'requested' && 'Finding driver...'}
                  {rideStatus === 'matched' && 'Driver on the way'}
                  {rideStatus === 'driver_arrived' && 'Driver arrived'}
                  {rideStatus === 'picked_up' && 'On trip'}
                </span>
              </div>
            </div>

            {currentRide.driver && (
              <div className="border-t pt-4">
                <h3 className="font-medium mb-2">Your Driver</h3>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-gray-200 rounded-full flex items-center justify-center text-xl">
                    👤
                  </div>
                  <div>
                    <p className="font-medium">{currentRide.driver.name}</p>
                    <p className="text-sm text-gray-600">
                      {currentRide.driver.vehicleColor} {currentRide.driver.vehicleMake}{' '}
                      {currentRide.driver.vehicleModel}
                    </p>
                    <p className="text-sm text-gray-500">{currentRide.driver.licensePlate}</p>
                  </div>
                  <div className="ml-auto text-right">
                    <p className="text-sm text-gray-600">Rating</p>
                    <p className="font-medium">{currentRide.driver.rating.toFixed(1)} ★</p>
                  </div>
                </div>
              </div>
            )}

            {rideStatus !== 'picked_up' && (
              <button
                onClick={() => cancelRide('Changed my mind')}
                disabled={isLoading}
                className="w-full mt-4 btn btn-danger"
              >
                Cancel Ride
              </button>
            )}
          </div>
        )}

        {/* Ride Completed - Rating */}
        {rideStatus === 'completed' && currentRide && (
          <div className="card mb-6">
            <h2 className="text-xl font-semibold mb-4">Ride Completed</h2>

            <div className="text-center mb-6">
              <p className="text-3xl font-bold">
                {formatCurrency(currentRide.fare?.final || currentRide.fare?.estimated || 0)}
              </p>
              <p className="text-gray-600">Total fare</p>
            </div>

            <div className="mb-6">
              <p className="text-center mb-4">Rate your driver</p>
              <div className="flex justify-center gap-2">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    onClick={() => setRating(star)}
                    className={`text-3xl ${star <= rating ? 'text-yellow-400' : 'text-gray-300'}`}
                  >
                    ★
                  </button>
                ))}
              </div>
            </div>

            <button onClick={() => rateRide(rating)} className="w-full btn btn-primary">
              Submit Rating
            </button>

            <button onClick={clearRide} className="w-full mt-2 btn btn-secondary">
              Skip
            </button>
          </div>
        )}

        {/* Request a Ride */}
        {!currentRide && (
          <>
            <div className="card mb-6">
              <h2 className="text-xl font-semibold mb-4">Where to?</h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Pickup location
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={pickupInput}
                      onChange={(e) => setPickupInput(e.target.value)}
                      placeholder="Enter pickup address"
                      className="input flex-1"
                    />
                    <button onClick={handleSetPickup} className="btn btn-secondary">
                      Set
                    </button>
                  </div>
                  {pickup && (
                    <p className="text-sm text-green-600 mt-1">
                      Pickup set: {pickup.address || `${pickup.lat.toFixed(4)}, ${pickup.lng.toFixed(4)}`}
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Dropoff location
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={dropoffInput}
                      onChange={(e) => setDropoffInput(e.target.value)}
                      placeholder="Enter destination"
                      className="input flex-1"
                    />
                    <button onClick={handleSetDropoff} className="btn btn-secondary">
                      Set
                    </button>
                  </div>
                  {dropoff && (
                    <p className="text-sm text-green-600 mt-1">
                      Dropoff set: {dropoff.address || `${dropoff.lat.toFixed(4)}, ${dropoff.lng.toFixed(4)}`}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Vehicle Options */}
            {estimates.length > 0 && (
              <div className="card mb-6">
                <h2 className="text-xl font-semibold mb-4">Choose a ride</h2>

                <div className="space-y-3">
                  {estimates.map((estimate: FareEstimate) => (
                    <button
                      key={estimate.vehicleType}
                      onClick={() => setSelectedVehicleType(estimate.vehicleType)}
                      className={`w-full p-4 rounded-lg border-2 flex items-center gap-4 transition-colors ${
                        selectedVehicleType === estimate.vehicleType
                          ? 'border-black bg-gray-50'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <span className="text-3xl">{getVehicleIcon(estimate.vehicleType)}</span>
                      <div className="flex-1 text-left">
                        <p className="font-medium capitalize">{estimate.vehicleType}</p>
                        <p className="text-sm text-gray-600">
                          {estimate.durationMinutes} min · {estimate.distanceMiles.toFixed(1)} mi
                        </p>
                        {estimate.availableDrivers === 0 && (
                          <p className="text-xs text-orange-600">No drivers nearby</p>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="font-semibold">{formatCurrency(estimate.totalFareCents)}</p>
                        {estimate.surgeMultiplier > 1 && (
                          <p className="text-xs text-red-600">
                            {estimate.surgeMultiplier}x surge
                          </p>
                        )}
                      </div>
                    </button>
                  ))}
                </div>

                <button
                  onClick={requestRide}
                  disabled={isLoading || !pickup || !dropoff}
                  className="w-full mt-6 btn btn-primary py-4 text-lg disabled:opacity-50"
                >
                  {isLoading ? 'Requesting...' : 'Request Ride'}
                </button>
              </div>
            )}

            {/* Loading estimates */}
            {isLoading && pickup && dropoff && estimates.length === 0 && (
              <div className="card text-center py-8">
                <p className="text-gray-600">Getting fare estimates...</p>
              </div>
            )}
          </>
        )}

        {/* Ride History Link */}
        <div className="text-center mt-8">
          <Link to="/rider/history" className="text-gray-600 hover:text-black underline">
            View ride history
          </Link>
        </div>
      </main>
    </div>
  );
}

export const Route = createFileRoute('/rider')({
  component: RiderPage,
});
