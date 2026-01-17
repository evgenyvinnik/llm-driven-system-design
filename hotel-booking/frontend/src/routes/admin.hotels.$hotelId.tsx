import { useState, useEffect } from 'react';
import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { Hotel, RoomType } from '@/types';
import { formatCurrency, getAmenityLabel } from '@/utils';

export const Route = createFileRoute('/admin/hotels/$hotelId')({
  component: ManageHotelPage,
});

function ManageHotelPage() {
  const { hotelId } = Route.useParams();
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading: authLoading } = useAuthStore();

  const [hotel, setHotel] = useState<Hotel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showRoomModal, setShowRoomModal] = useState(false);
  const [editingRoom, setEditingRoom] = useState<RoomType | null>(null);
  const [showPricingModal, setShowPricingModal] = useState(false);
  const [pricingRoomId, setPricingRoomId] = useState<string | null>(null);

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

      loadHotel();
    }
  }, [hotelId, isAuthenticated, authLoading, user]);

  const loadHotel = async () => {
    setLoading(true);
    try {
      const data = await api.getHotel(hotelId);
      setHotel(data);
    } catch (err) {
      setError('Failed to load hotel');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteRoom = async (roomId: string) => {
    if (!confirm('Are you sure you want to delete this room type?')) return;

    try {
      await api.deleteRoomType(roomId);
      loadHotel();
    } catch (err) {
      console.error('Failed to delete room:', err);
      alert('Failed to delete room type. It may have existing bookings.');
    }
  };

  if (authLoading || loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
      </div>
    );
  }

  if (error || !hotel) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">{error || 'Hotel not found'}</p>
        <Link to="/admin" className="btn-primary mt-4">
          Back to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <Link to="/admin" className="text-primary-600 hover:text-primary-700 mb-4 inline-flex items-center">
        <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Dashboard
      </Link>

      {/* Hotel Header */}
      <div className="card p-6 mt-4 mb-8">
        <div className="flex flex-col md:flex-row gap-6">
          <img
            src={hotel.images?.[0] || 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=300'}
            alt={hotel.name}
            className="w-full md:w-48 h-48 object-cover rounded-lg"
          />
          <div className="flex-1">
            <div className="flex justify-between items-start">
              <div>
                <h1 className="text-2xl font-bold text-gray-900">{hotel.name}</h1>
                <p className="text-gray-500">{hotel.address}, {hotel.city}, {hotel.country}</p>
                <div className="flex items-center gap-4 mt-2">
                  <span className="text-yellow-500">{'★'.repeat(hotel.starRating)}</span>
                  {hotel.avgRating > 0 && (
                    <span className="text-sm text-gray-500">
                      {hotel.avgRating.toFixed(1)} ({hotel.reviewCount} reviews)
                    </span>
                  )}
                </div>
              </div>
              <Link to={`/hotels/${hotel.id}`} className="btn-secondary text-sm">
                View Public Page
              </Link>
            </div>
            <p className="text-gray-600 mt-4">{hotel.description}</p>
            <div className="flex flex-wrap gap-2 mt-4">
              {hotel.amenities?.map((amenity) => (
                <span key={amenity} className="bg-gray-100 text-gray-600 px-2 py-1 rounded text-sm">
                  {getAmenityLabel(amenity)}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Room Types */}
      <div className="card p-6">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold">Room Types</h2>
          <button
            onClick={() => {
              setEditingRoom(null);
              setShowRoomModal(true);
            }}
            className="btn-primary"
          >
            Add Room Type
          </button>
        </div>

        {hotel.roomTypes && hotel.roomTypes.length > 0 ? (
          <div className="space-y-4">
            {hotel.roomTypes.map((room) => (
              <div key={room.id} className="border rounded-lg p-4">
                <div className="flex flex-col md:flex-row gap-4">
                  <img
                    src={room.images?.[0] || 'https://images.unsplash.com/photo-1582719508461-905c673771fd?w=200'}
                    alt={room.name}
                    className="w-full md:w-32 h-32 object-cover rounded-lg"
                  />
                  <div className="flex-1">
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className="text-lg font-semibold">{room.name}</h3>
                        <p className="text-gray-500 text-sm">
                          Capacity: {room.capacity} | {room.bedType} | {room.sizeSqm}m2
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xl font-bold">{formatCurrency(room.basePrice)}</p>
                        <p className="text-sm text-gray-500">per night</p>
                      </div>
                    </div>
                    <p className="text-gray-600 text-sm mt-2">{room.description}</p>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {room.amenities?.slice(0, 5).map((amenity) => (
                        <span key={amenity} className="bg-gray-100 text-gray-600 px-2 py-0.5 rounded text-xs">
                          {getAmenityLabel(amenity)}
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center justify-between mt-4">
                      <div className="text-sm text-gray-500">
                        {room.totalCount} rooms total
                      </div>
                      <div className="flex space-x-2">
                        <button
                          onClick={() => {
                            setPricingRoomId(room.id);
                            setShowPricingModal(true);
                          }}
                          className="text-sm text-primary-600 hover:text-primary-700"
                        >
                          Manage Pricing
                        </button>
                        <button
                          onClick={() => {
                            setEditingRoom(room);
                            setShowRoomModal(true);
                          }}
                          className="text-sm text-gray-600 hover:text-gray-700"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteRoom(room.id)}
                          className="text-sm text-red-600 hover:text-red-700"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-8 text-gray-500">
            No room types yet. Add your first room type to start accepting bookings.
          </div>
        )}
      </div>

      {/* Room Modal */}
      {showRoomModal && (
        <RoomTypeModal
          hotelId={hotelId}
          room={editingRoom}
          onClose={() => {
            setShowRoomModal(false);
            setEditingRoom(null);
          }}
          onSuccess={() => {
            setShowRoomModal(false);
            setEditingRoom(null);
            loadHotel();
          }}
        />
      )}

      {/* Pricing Modal */}
      {showPricingModal && pricingRoomId && (
        <PricingModal
          roomTypeId={pricingRoomId}
          onClose={() => {
            setShowPricingModal(false);
            setPricingRoomId(null);
          }}
        />
      )}
    </div>
  );
}

function RoomTypeModal({
  hotelId,
  room,
  onClose,
  onSuccess,
}: {
  hotelId: string;
  room: RoomType | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [formData, setFormData] = useState({
    name: room?.name || '',
    description: room?.description || '',
    capacity: room?.capacity || 2,
    bedType: room?.bedType || 'Queen',
    totalCount: room?.totalCount || 1,
    basePrice: room?.basePrice || 100,
    amenities: room?.amenities || [],
    sizeSqm: room?.sizeSqm || 25,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const amenityOptions = ['wifi', 'tv', 'minibar', 'safe', 'balcony', 'bathtub', 'living_room', 'kitchen'];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (room) {
        await api.updateRoomType(room.id, formData);
      } else {
        await api.createRoomType(hotelId, formData);
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save room type');
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
      <div className="bg-white rounded-xl p-6 max-w-lg w-full max-h-[90vh] overflow-auto">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold">{room ? 'Edit Room Type' : 'Add Room Type'}</h2>
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
            <label className="label">Room Name *</label>
            <input
              type="text"
              className="input"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="e.g., Deluxe King Room"
              required
            />
          </div>

          <div>
            <label className="label">Description</label>
            <textarea
              className="input"
              rows={2}
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Capacity *</label>
              <input
                type="number"
                className="input"
                min="1"
                value={formData.capacity}
                onChange={(e) => setFormData({ ...formData, capacity: Number(e.target.value) })}
                required
              />
            </div>
            <div>
              <label className="label">Bed Type</label>
              <select
                className="input"
                value={formData.bedType}
                onChange={(e) => setFormData({ ...formData, bedType: e.target.value })}
              >
                <option>Single</option>
                <option>Double</option>
                <option>Queen</option>
                <option>King</option>
                <option>Twin</option>
                <option>Multiple</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Total Rooms *</label>
              <input
                type="number"
                className="input"
                min="1"
                value={formData.totalCount}
                onChange={(e) => setFormData({ ...formData, totalCount: Number(e.target.value) })}
                required
              />
            </div>
            <div>
              <label className="label">Size (m2)</label>
              <input
                type="number"
                className="input"
                min="1"
                value={formData.sizeSqm}
                onChange={(e) => setFormData({ ...formData, sizeSqm: Number(e.target.value) })}
              />
            </div>
          </div>

          <div>
            <label className="label">Base Price per Night *</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
              <input
                type="number"
                className="input pl-8"
                min="1"
                step="0.01"
                value={formData.basePrice}
                onChange={(e) => setFormData({ ...formData, basePrice: Number(e.target.value) })}
                required
              />
            </div>
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
                  {getAmenityLabel(amenity)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex space-x-4 pt-4">
            <button type="submit" disabled={loading} className="btn-primary flex-1">
              {loading ? 'Saving...' : room ? 'Update Room' : 'Add Room'}
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

function PricingModal({
  roomTypeId,
  onClose,
}: {
  roomTypeId: string;
  onClose: () => void;
}) {
  const [date, setDate] = useState('');
  const [price, setPrice] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      await api.setPriceOverride(roomTypeId, date, Number(price));
      setSuccess(`Price set for ${date}`);
      setDate('');
      setPrice('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set price');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl p-6 max-w-md w-full">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold">Manage Pricing</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="text-gray-600 mb-4">
          Set custom pricing for specific dates. This will override the base price.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-red-800 text-sm">{error}</p>
            </div>
          )}
          {success && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3">
              <p className="text-green-800 text-sm">{success}</p>
            </div>
          )}

          <div>
            <label className="label">Date</label>
            <input
              type="date"
              className="input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              min={new Date().toISOString().split('T')[0]}
              required
            />
          </div>

          <div>
            <label className="label">Price</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
              <input
                type="number"
                className="input pl-8"
                min="1"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="flex space-x-4 pt-4">
            <button type="submit" disabled={loading} className="btn-primary flex-1">
              {loading ? 'Saving...' : 'Set Price'}
            </button>
            <button type="button" onClick={onClose} className="btn-secondary flex-1">
              Close
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
