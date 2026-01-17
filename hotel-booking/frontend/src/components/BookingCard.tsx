import { Link } from '@tanstack/react-router';
import type { Booking } from '@/types';
import { formatCurrency, formatDateRange, getStatusColor, getStatusLabel, getNights } from '@/utils';

interface BookingCardProps {
  booking: Booking;
  showActions?: boolean;
  onCancel?: (bookingId: string) => void;
  onConfirm?: (bookingId: string) => void;
}

export function BookingCard({ booking, showActions = true, onCancel, onConfirm }: BookingCardProps) {
  const nights = getNights(booking.checkIn, booking.checkOut);

  return (
    <div className="card p-4">
      <div className="flex flex-col md:flex-row gap-4">
        <div className="md:w-1/4">
          <img
            src={booking.hotelImages?.[0] || 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=400'}
            alt={booking.hotelName || 'Hotel'}
            className="w-full h-32 object-cover rounded-lg"
          />
        </div>
        <div className="md:w-3/4">
          <div className="flex justify-between items-start mb-2">
            <div>
              <Link
                to={`/hotels/${booking.hotelId}`}
                className="text-lg font-semibold text-gray-900 hover:text-primary-600"
              >
                {booking.hotelName}
              </Link>
              <p className="text-sm text-gray-500">
                {booking.hotelAddress}, {booking.hotelCity}
              </p>
            </div>
            <span className={`px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(booking.status)}`}>
              {getStatusLabel(booking.status)}
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div>
              <p className="text-xs text-gray-500">Room Type</p>
              <p className="font-medium">{booking.roomTypeName}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Dates</p>
              <p className="font-medium">{formatDateRange(booking.checkIn, booking.checkOut)}</p>
              <p className="text-xs text-gray-500">{nights} night{nights !== 1 ? 's' : ''}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Guests</p>
              <p className="font-medium">{booking.guestCount} guest{booking.guestCount !== 1 ? 's' : ''}</p>
              <p className="text-xs text-gray-500">{booking.roomCount} room{booking.roomCount !== 1 ? 's' : ''}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Total Price</p>
              <p className="text-xl font-bold text-gray-900">{formatCurrency(booking.totalPrice)}</p>
            </div>
          </div>

          {showActions && (
            <div className="flex space-x-3">
              <Link to={`/bookings/${booking.id}`} className="btn-secondary text-sm">
                View Details
              </Link>
              {booking.status === 'reserved' && onConfirm && (
                <button
                  onClick={() => onConfirm(booking.id)}
                  className="btn-primary text-sm"
                >
                  Confirm & Pay
                </button>
              )}
              {(booking.status === 'reserved' || booking.status === 'confirmed') && onCancel && (
                <button
                  onClick={() => onCancel(booking.id)}
                  className="text-sm text-red-600 hover:text-red-700 font-medium"
                >
                  Cancel Booking
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
