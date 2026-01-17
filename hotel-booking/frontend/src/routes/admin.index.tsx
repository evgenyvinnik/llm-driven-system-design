import { useState, useEffect } from 'react';
import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { Hotel, Booking } from '@/types';
import { formatCurrency, formatDate, getStatusColor, getStatusLabel } from '@/utils';

export const Route = createFileRoute('/admin/')({
  component: AdminDashboardPage,
});

function AdminDashboardPage() {
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading: authLoading } = useAuthStore();
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [selectedHotel, setSelectedHotel] = useState<string | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [bookingsLoading, setBookingsLoading] = useState(false);
  const [showCreateHotelModal, setShowCreateHotelModal] = useState(false);

  useEffect(() => {
    if (!authLoading) {
      if (!isAuthenticated) {
        navigate({ to: '/login' });
        return;
      }

      if (user?.role !== 'hotel_admin' && user?.role !== 'admin') {
        navigate({ to: '/' });
        return;
      }

      loadHotels();
    }
  }, [isAuthenticated, authLoading, user]);

  useEffect(() => {
    if (selectedHotel) {
      loadBookings(selectedHotel);
    }
  }, [selectedHotel]);

  const loadHotels = async () => {
    setLoading(true);
    try {
      const data = await api.getMyHotels();
      setHotels(data);
      if (data.length > 0 && !selectedHotel) {
        setSelectedHotel(data[0].id);
      }
    } catch (err) {
      console.error('Failed to load hotels:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadBookings = async (hotelId: string) => {
    setBookingsLoading(true);
    try {
      const data = await api.getHotelBookings(hotelId);
      setBookings(data);
    } catch (err) {
      console.error('Failed to load bookings:', err);
    } finally {
      setBookingsLoading(false);
    }
  };

  const currentHotel = hotels.find((h) => h.id === selectedHotel);

  // Calculate stats
  const totalBookings = bookings.length;
  const confirmedBookings = bookings.filter((b) => b.status === 'confirmed').length;
  const pendingBookings = bookings.filter((b) => b.status === 'reserved').length;
  const totalRevenue = bookings
    .filter((b) => b.status === 'confirmed' || b.status === 'completed')
    .reduce((sum, b) => sum + b.totalPrice, 0);

  if (authLoading || loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Hotel Admin Dashboard</h1>
        <button
          onClick={() => setShowCreateHotelModal(true)}
          className="btn-primary"
        >
          Add New Hotel
        </button>
      </div>

      {hotels.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl shadow-sm border">
          <h2 className="text-xl font-medium text-gray-900 mb-2">No Hotels Yet</h2>
          <p className="text-gray-500 mb-4">Start by adding your first property</p>
          <button
            onClick={() => setShowCreateHotelModal(true)}
            className="btn-primary"
          >
            Add Your First Hotel
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
          {/* Hotel Selector Sidebar */}
          <div className="lg:col-span-1">
            <div className="card p-4">
              <h2 className="font-semibold mb-4">Your Properties</h2>
              <div className="space-y-2">
                {hotels.map((hotel) => (
                  <button
                    key={hotel.id}
                    onClick={() => setSelectedHotel(hotel.id)}
                    className={`w-full text-left p-3 rounded-lg transition-colors ${
                      selectedHotel === hotel.id
                        ? 'bg-primary-50 border-primary-200 border'
                        : 'hover:bg-gray-50'
                    }`}
                  >
                    <p className="font-medium text-gray-900">{hotel.name}</p>
                    <p className="text-sm text-gray-500">{hotel.city}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Main Content */}
          <div className="lg:col-span-3 space-y-6">
            {currentHotel && (
              <>
                {/* Hotel Info */}
                <div className="card p-6">
                  <div className="flex justify-between items-start">
                    <div className="flex gap-4">
                      <img
                        src={currentHotel.images?.[0] || 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=200'}
                        alt={currentHotel.name}
                        className="w-24 h-24 object-cover rounded-lg"
                      />
                      <div>
                        <h2 className="text-xl font-bold text-gray-900">{currentHotel.name}</h2>
                        <p className="text-gray-500">{currentHotel.address}, {currentHotel.city}</p>
                        <div className="flex items-center gap-4 mt-2">
                          <span className="text-yellow-500">{'★'.repeat(currentHotel.starRating)}</span>
                          {currentHotel.avgRating > 0 && (
                            <span className="text-sm text-gray-500">
                              {currentHotel.avgRating.toFixed(1)} ({currentHotel.reviewCount} reviews)
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <Link
                      to={`/admin/hotels/${currentHotel.id}`}
                      className="btn-secondary text-sm"
                    >
                      Manage Hotel
                    </Link>
                  </div>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="card p-4 text-center">
                    <p className="text-3xl font-bold text-gray-900">{totalBookings}</p>
                    <p className="text-sm text-gray-500">Total Bookings</p>
                  </div>
                  <div className="card p-4 text-center">
                    <p className="text-3xl font-bold text-green-600">{confirmedBookings}</p>
                    <p className="text-sm text-gray-500">Confirmed</p>
                  </div>
                  <div className="card p-4 text-center">
                    <p className="text-3xl font-bold text-yellow-600">{pendingBookings}</p>
                    <p className="text-sm text-gray-500">Pending</p>
                  </div>
                  <div className="card p-4 text-center">
                    <p className="text-3xl font-bold text-primary-600">{formatCurrency(totalRevenue)}</p>
                    <p className="text-sm text-gray-500">Total Revenue</p>
                  </div>
                </div>

                {/* Recent Bookings */}
                <div className="card p-6">
                  <h3 className="font-semibold mb-4">Recent Bookings</h3>
                  {bookingsLoading ? (
                    <div className="flex justify-center py-8">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
                    </div>
                  ) : bookings.length === 0 ? (
                    <p className="text-gray-500 text-center py-8">No bookings yet</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="text-left text-sm text-gray-500 border-b">
                            <th className="pb-3 pr-4">Guest</th>
                            <th className="pb-3 pr-4">Room</th>
                            <th className="pb-3 pr-4">Check-in</th>
                            <th className="pb-3 pr-4">Check-out</th>
                            <th className="pb-3 pr-4">Status</th>
                            <th className="pb-3">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bookings.slice(0, 10).map((booking) => (
                            <tr key={booking.id} className="border-b last:border-0">
                              <td className="py-3 pr-4">
                                <p className="font-medium">{booking.guestFirstName} {booking.guestLastName}</p>
                                <p className="text-sm text-gray-500">{booking.guestEmail}</p>
                              </td>
                              <td className="py-3 pr-4">{booking.roomTypeName}</td>
                              <td className="py-3 pr-4">{formatDate(booking.checkIn)}</td>
                              <td className="py-3 pr-4">{formatDate(booking.checkOut)}</td>
                              <td className="py-3 pr-4">
                                <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(booking.status)}`}>
                                  {getStatusLabel(booking.status)}
                                </span>
                              </td>
                              <td className="py-3 font-medium">{formatCurrency(booking.totalPrice)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Create Hotel Modal */}
      {showCreateHotelModal && (
        <CreateHotelModal
          onClose={() => setShowCreateHotelModal(false)}
          onSuccess={() => {
            setShowCreateHotelModal(false);
            loadHotels();
          }}
        />
      )}
    </div>
  );
}

function CreateHotelModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    address: '',
    city: '',
    state: '',
    country: 'USA',
    postalCode: '',
    starRating: 3,
    amenities: [] as string[],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const amenityOptions = ['wifi', 'pool', 'gym', 'spa', 'restaurant', 'bar', 'parking', 'room_service'];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      await api.createHotel(formData);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create hotel');
    } finally {
      setLoading(false);
    }
  };

  const toggleAmenity = (amenity: string) => {
    setFormData({
      ...formData,
      amenities: formData.amenities.includes(amenity)
        ? formData.amenities.filter((a) => a !== amenity)
        : [...formData.amenities, amenity],
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl p-6 max-w-2xl w-full max-h-[90vh] overflow-auto">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold">Add New Hotel</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-red-800 text-sm">{error}</p>
            </div>
          )}

          <div>
            <label className="label">Hotel Name *</label>
            <input
              type="text"
              className="input"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              required
            />
          </div>

          <div>
            <label className="label">Description</label>
            <textarea
              className="input"
              rows={3}
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Address *</label>
              <input
                type="text"
                className="input"
                value={formData.address}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                required
              />
            </div>
            <div>
              <label className="label">City *</label>
              <input
                type="text"
                className="input"
                value={formData.city}
                onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="label">State</label>
              <input
                type="text"
                className="input"
                value={formData.state}
                onChange={(e) => setFormData({ ...formData, state: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Country *</label>
              <input
                type="text"
                className="input"
                value={formData.country}
                onChange={(e) => setFormData({ ...formData, country: e.target.value })}
                required
              />
            </div>
            <div>
              <label className="label">Postal Code</label>
              <input
                type="text"
                className="input"
                value={formData.postalCode}
                onChange={(e) => setFormData({ ...formData, postalCode: e.target.value })}
              />
            </div>
          </div>

          <div>
            <label className="label">Star Rating</label>
            <select
              className="input"
              value={formData.starRating}
              onChange={(e) => setFormData({ ...formData, starRating: Number(e.target.value) })}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>{n} Star{n !== 1 ? 's' : ''}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Amenities</label>
            <div className="flex flex-wrap gap-2">
              {amenityOptions.map((amenity) => (
                <button
                  key={amenity}
                  type="button"
                  onClick={() => toggleAmenity(amenity)}
                  className={`px-3 py-1 rounded-full text-sm ${
                    formData.amenities.includes(amenity)
                      ? 'bg-primary-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {amenity.replace(/_/g, ' ')}
                </button>
              ))}
            </div>
          </div>

          <div className="flex space-x-4 pt-4">
            <button type="submit" disabled={loading} className="btn-primary flex-1">
              {loading ? 'Creating...' : 'Create Hotel'}
            </button>
            <button type="button" onClick={onClose} className="btn-secondary flex-1">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
