import { useState, useEffect } from 'react';
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { RoomTypeCard, AvailabilityCalendar } from '@/components';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { Hotel, RoomType, Review } from '@/types';
import { formatCurrency, generateStars, getAmenityLabel, getNights, getDefaultCheckIn, getDefaultCheckOut } from '@/utils';

export const Route = createFileRoute('/hotels/$hotelId')({
  component: HotelDetailPage,
});

function HotelDetailPage() {
  const { hotelId } = Route.useParams();
  const search = useSearch({ from: '/hotels/$hotelId' });
  const navigate = useNavigate();
  const { isAuthenticated } = useAuthStore();

  const [hotel, setHotel] = useState<Hotel | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<RoomType | null>(null);
  const [checkIn, setCheckIn] = useState((search as { checkIn?: string }).checkIn || getDefaultCheckIn());
  const [checkOut, setCheckOut] = useState((search as { checkOut?: string }).checkOut || getDefaultCheckOut());
  const [guests, setGuests] = useState(2);
  const [rooms, setRooms] = useState(1);
  const [showCalendar, setShowCalendar] = useState(false);
  const [calendarRoomTypeId, setCalendarRoomTypeId] = useState<string | null>(null);

  useEffect(() => {
    loadHotel();
    loadReviews();
  }, [hotelId, checkIn, checkOut, guests]);

  const loadHotel = async () => {
    setLoading(true);
    try {
      const data = await api.getHotel(hotelId, checkIn, checkOut, guests);
      setHotel(data);
    } catch (err) {
      setError('Failed to load hotel details');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const loadReviews = async () => {
    try {
      const data = await api.getReviews(hotelId);
      setReviews(data.reviews);
    } catch (err) {
      console.error('Failed to load reviews:', err);
    }
  };

  const handleRoomSelect = (roomType: RoomType) => {
    setSelectedRoom(roomType);
  };

  const handleBookNow = () => {
    if (!selectedRoom) return;

    if (!isAuthenticated) {
      navigate({ to: '/login', search: { redirect: window.location.pathname + window.location.search } });
      return;
    }

    navigate({
      to: '/booking',
      search: {
        hotelId,
        roomTypeId: selectedRoom.id,
        checkIn,
        checkOut,
        guests,
        rooms,
      },
    });
  };

  const handleDateSelect = (newCheckIn: string, newCheckOut: string) => {
    setCheckIn(newCheckIn);
    setCheckOut(newCheckOut);
    setShowCalendar(false);
    setCalendarRoomTypeId(null);
  };

  const nights = getNights(checkIn, checkOut);

  if (loading) {
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
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Hero Images */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="md:col-span-2">
          <img
            src={hotel.images?.[0] || 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800'}
            alt={hotel.name}
            className="w-full h-96 object-cover rounded-xl"
          />
        </div>
        <div className="hidden md:grid grid-rows-2 gap-4">
          {hotel.images?.slice(1, 3).map((img, i) => (
            <img
              key={i}
              src={img}
              alt={`${hotel.name} ${i + 2}`}
              className="w-full h-full object-cover rounded-xl"
            />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main Content */}
        <div className="lg:col-span-2">
          {/* Header */}
          <div className="mb-6">
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="flex items-center space-x-2 mb-1">
                  <span className="text-yellow-500">{generateStars(hotel.starRating)}</span>
                </div>
                <h1 className="text-3xl font-bold text-gray-900">{hotel.name}</h1>
                <p className="text-gray-500">
                  {hotel.address}, {hotel.city}, {hotel.country}
                </p>
              </div>
              {hotel.avgRating > 0 && (
                <div className="bg-primary-600 text-white px-4 py-2 rounded-lg text-center">
                  <div className="text-2xl font-bold">{hotel.avgRating.toFixed(1)}</div>
                  <div className="text-xs">{hotel.reviewCount} reviews</div>
                </div>
              )}
            </div>
          </div>

          {/* Description */}
          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-3">About this hotel</h2>
            <p className="text-gray-600">{hotel.description}</p>
          </div>

          {/* Amenities */}
          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-3">Amenities</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {hotel.amenities?.map((amenity) => (
                <div key={amenity} className="flex items-center space-x-2 text-gray-600">
                  <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span>{getAmenityLabel(amenity)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Room Types */}
          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-4">Available Rooms</h2>
            <div className="space-y-4">
              {hotel.roomTypes?.map((roomType) => (
                <div key={roomType.id}>
                  <RoomTypeCard
                    roomType={roomType}
                    nights={nights}
                    onSelect={handleRoomSelect}
                    isSelected={selectedRoom?.id === roomType.id}
                  />
                  <button
                    onClick={() => {
                      setCalendarRoomTypeId(roomType.id);
                      setShowCalendar(true);
                    }}
                    className="text-sm text-primary-600 hover:text-primary-700 mt-2"
                  >
                    View availability calendar
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Calendar Modal */}
          {showCalendar && calendarRoomTypeId && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
              <div className="bg-white rounded-xl p-6 max-w-lg w-full max-h-[90vh] overflow-auto">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-semibold">Select Dates</h3>
                  <button
                    onClick={() => setShowCalendar(false)}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <AvailabilityCalendar
                  hotelId={hotelId}
                  roomTypeId={calendarRoomTypeId}
                  selectedCheckIn={checkIn}
                  selectedCheckOut={checkOut}
                  onDateSelect={handleDateSelect}
                />
              </div>
            </div>
          )}

          {/* Policies */}
          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-3">Policies</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-gray-50 p-4 rounded-lg">
                <h3 className="font-medium mb-2">Check-in / Check-out</h3>
                <p className="text-gray-600">Check-in: {hotel.checkInTime}</p>
                <p className="text-gray-600">Check-out: {hotel.checkOutTime}</p>
              </div>
              <div className="bg-gray-50 p-4 rounded-lg">
                <h3 className="font-medium mb-2">Cancellation</h3>
                <p className="text-gray-600">{hotel.cancellationPolicy}</p>
              </div>
            </div>
          </div>

          {/* Reviews */}
          <div>
            <h2 className="text-xl font-semibold mb-4">Guest Reviews</h2>
            {reviews.length === 0 ? (
              <p className="text-gray-500">No reviews yet</p>
            ) : (
              <div className="space-y-4">
                {reviews.map((review) => (
                  <div key={review.id} className="bg-gray-50 p-4 rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center space-x-2">
                        <div className="w-10 h-10 bg-primary-100 rounded-full flex items-center justify-center">
                          <span className="text-primary-600 font-medium">
                            {review.authorFirstName?.[0]}{review.authorLastName?.[0]}
                          </span>
                        </div>
                        <div>
                          <p className="font-medium">{review.authorFirstName} {review.authorLastName}</p>
                          <p className="text-xs text-gray-500">{new Date(review.createdAt).toLocaleDateString()}</p>
                        </div>
                      </div>
                      <div className="bg-primary-600 text-white px-2 py-1 rounded font-bold">
                        {review.rating}
                      </div>
                    </div>
                    {review.title && <h4 className="font-medium mb-1">{review.title}</h4>}
                    <p className="text-gray-600">{review.content}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Sidebar - Booking Widget */}
        <div className="lg:col-span-1">
          <div className="sticky top-24 card p-6">
            <h3 className="text-lg font-semibold mb-4">Book Your Stay</h3>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Check-in</label>
                  <input
                    type="date"
                    className="input"
                    value={checkIn}
                    onChange={(e) => setCheckIn(e.target.value)}
                    min={new Date().toISOString().split('T')[0]}
                  />
                </div>
                <div>
                  <label className="label">Check-out</label>
                  <input
                    type="date"
                    className="input"
                    value={checkOut}
                    onChange={(e) => setCheckOut(e.target.value)}
                    min={checkIn}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Guests</label>
                  <select
                    className="input"
                    value={guests}
                    onChange={(e) => setGuests(Number(e.target.value))}
                  >
                    {[1, 2, 3, 4, 5, 6].map((n) => (
                      <option key={n} value={n}>{n} guest{n !== 1 ? 's' : ''}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Rooms</label>
                  <select
                    className="input"
                    value={rooms}
                    onChange={(e) => setRooms(Number(e.target.value))}
                  >
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>{n} room{n !== 1 ? 's' : ''}</option>
                    ))}
                  </select>
                </div>
              </div>

              {selectedRoom && (
                <div className="border-t pt-4">
                  <div className="flex justify-between mb-2">
                    <span className="text-gray-600">Selected Room</span>
                    <span className="font-medium">{selectedRoom.name}</span>
                  </div>
                  <div className="flex justify-between mb-2">
                    <span className="text-gray-600">
                      {formatCurrency(selectedRoom.pricePerNight || selectedRoom.basePrice)} x {nights} night{nights !== 1 ? 's' : ''}
                    </span>
                    <span className="font-medium">
                      {formatCurrency((selectedRoom.totalPrice || selectedRoom.basePrice * nights) * rooms)}
                    </span>
                  </div>
                  <div className="flex justify-between text-lg font-bold border-t pt-2">
                    <span>Total</span>
                    <span>{formatCurrency((selectedRoom.totalPrice || selectedRoom.basePrice * nights) * rooms)}</span>
                  </div>
                </div>
              )}

              <button
                onClick={handleBookNow}
                disabled={!selectedRoom}
                className="btn-primary w-full py-3 text-lg"
              >
                {selectedRoom ? 'Book Now' : 'Select a Room'}
              </button>

              <p className="text-xs text-gray-500 text-center">
                You won't be charged yet. A hold will be placed on your room.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
