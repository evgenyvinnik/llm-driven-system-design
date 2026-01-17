import { useState, useEffect } from 'react';
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { Hotel, RoomType } from '@/types';
import { formatCurrency, formatDateRange, getNights } from '@/utils';

export const Route = createFileRoute('/booking')({
  component: BookingPage,
});

function BookingPage() {
  const search = useSearch({ from: '/booking' }) as {
    hotelId?: string;
    roomTypeId?: string;
    checkIn?: string;
    checkOut?: string;
    guests?: number;
    rooms?: number;
  };
  const navigate = useNavigate();
  const { user, isAuthenticated } = useAuthStore();

  const [hotel, setHotel] = useState<Hotel | null>(null);
  const [roomType, setRoomType] = useState<RoomType | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    guestFirstName: user?.firstName || '',
    guestLastName: user?.lastName || '',
    guestEmail: user?.email || '',
    guestPhone: '',
    specialRequests: '',
  });

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }

    if (!search.hotelId || !search.roomTypeId || !search.checkIn || !search.checkOut) {
      navigate({ to: '/' });
      return;
    }

    loadData();
  }, [search, isAuthenticated]);

  const loadData = async () => {
    setLoading(true);
    try {
      const hotelData = await api.getHotel(
        search.hotelId!,
        search.checkIn,
        search.checkOut,
        search.guests
      );
      setHotel(hotelData);

      const room = hotelData.roomTypes?.find((rt) => rt.id === search.roomTypeId);
      if (room) {
        setRoomType(room);
      }
    } catch (err) {
      setError('Failed to load booking details');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const booking = await api.createBooking({
        hotelId: search.hotelId!,
        roomTypeId: search.roomTypeId!,
        checkIn: search.checkIn!,
        checkOut: search.checkOut!,
        roomCount: search.rooms || 1,
        guestCount: search.guests || 2,
        ...formData,
      });

      // Navigate to confirmation page
      navigate({ to: `/bookings/${booking.id}` });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create booking');
    } finally {
      setSubmitting(false);
    }
  };

  const nights = search.checkIn && search.checkOut ? getNights(search.checkIn, search.checkOut) : 1;
  const roomCount = search.rooms || 1;
  const totalPrice = roomType
    ? (roomType.totalPrice || roomType.basePrice * nights) * roomCount
    : 0;

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
      </div>
    );
  }

  if (!hotel || !roomType) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">{error || 'Booking details not found'}</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-8">Complete Your Booking</h1>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Booking Form */}
        <div className="lg:col-span-2">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Guest Details */}
            <div className="card p-6">
              <h2 className="text-lg font-semibold mb-4">Guest Details</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="label">First Name *</label>
                  <input
                    type="text"
                    className="input"
                    required
                    value={formData.guestFirstName}
                    onChange={(e) => setFormData({ ...formData, guestFirstName: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label">Last Name *</label>
                  <input
                    type="text"
                    className="input"
                    required
                    value={formData.guestLastName}
                    onChange={(e) => setFormData({ ...formData, guestLastName: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label">Email *</label>
                  <input
                    type="email"
                    className="input"
                    required
                    value={formData.guestEmail}
                    onChange={(e) => setFormData({ ...formData, guestEmail: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label">Phone</label>
                  <input
                    type="tel"
                    className="input"
                    value={formData.guestPhone}
                    onChange={(e) => setFormData({ ...formData, guestPhone: e.target.value })}
                  />
                </div>
              </div>
            </div>

            {/* Special Requests */}
            <div className="card p-6">
              <h2 className="text-lg font-semibold mb-4">Special Requests</h2>
              <textarea
                className="input"
                rows={4}
                placeholder="Any special requests? (e.g., late check-in, room preferences)"
                value={formData.specialRequests}
                onChange={(e) => setFormData({ ...formData, specialRequests: e.target.value })}
              />
              <p className="text-sm text-gray-500 mt-2">
                Special requests are subject to availability and cannot be guaranteed.
              </p>
            </div>

            {/* Payment Simulation */}
            <div className="card p-6">
              <h2 className="text-lg font-semibold mb-4">Payment</h2>
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <p className="text-yellow-800 text-sm">
                  <strong>Demo Mode:</strong> This is a demo application. No actual payment will be processed.
                  Click "Reserve Now" to simulate a booking reservation.
                </p>
              </div>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="text-red-800">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="btn-primary w-full py-3 text-lg"
            >
              {submitting ? 'Processing...' : 'Reserve Now'}
            </button>

            <p className="text-xs text-gray-500 text-center">
              By clicking Reserve Now, you agree to our Terms of Service and Privacy Policy.
              Your booking will be held for 15 minutes.
            </p>
          </form>
        </div>

        {/* Booking Summary */}
        <div className="lg:col-span-1">
          <div className="card p-6 sticky top-24">
            <h2 className="text-lg font-semibold mb-4">Booking Summary</h2>

            <div className="flex gap-4 mb-4">
              <img
                src={hotel.images?.[0] || 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=200'}
                alt={hotel.name}
                className="w-20 h-20 object-cover rounded-lg"
              />
              <div>
                <h3 className="font-medium">{hotel.name}</h3>
                <p className="text-sm text-gray-500">{hotel.city}, {hotel.country}</p>
              </div>
            </div>

            <div className="space-y-3 border-t pt-4">
              <div className="flex justify-between">
                <span className="text-gray-600">Room</span>
                <span className="font-medium">{roomType.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Dates</span>
                <span className="font-medium">
                  {search.checkIn && search.checkOut && formatDateRange(search.checkIn, search.checkOut)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Nights</span>
                <span className="font-medium">{nights}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Rooms</span>
                <span className="font-medium">{roomCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Guests</span>
                <span className="font-medium">{search.guests || 2}</span>
              </div>
            </div>

            <div className="border-t pt-4 mt-4">
              <div className="flex justify-between mb-2">
                <span className="text-gray-600">
                  {formatCurrency(roomType.pricePerNight || roomType.basePrice)} x {nights} night{nights !== 1 ? 's' : ''} x {roomCount} room{roomCount !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="flex justify-between text-xl font-bold">
                <span>Total</span>
                <span>{formatCurrency(totalPrice)}</span>
              </div>
            </div>

            <div className="mt-4 text-sm text-gray-500">
              <p><strong>Check-in:</strong> {hotel.checkInTime}</p>
              <p><strong>Check-out:</strong> {hotel.checkOutTime}</p>
            </div>

            <div className="mt-4 bg-green-50 rounded-lg p-3">
              <p className="text-sm text-green-800">
                <strong>Free cancellation</strong> - {hotel.cancellationPolicy}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
