import { useState, useEffect } from 'react';
import { Listing, AvailabilityBlock } from '../types';
import { listingsAPI, bookingsAPI } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useNavigate } from '@tanstack/react-router';
import { Calendar } from './Calendar';
import { formatCurrency, getNights } from '../utils/helpers';
import { format, addDays, parseISO } from 'date-fns';

interface BookingWidgetProps {
  listing: Listing;
}

export function BookingWidget({ listing }: BookingWidgetProps) {
  const { isAuthenticated } = useAuthStore();
  const navigate = useNavigate();

  const [checkIn, setCheckIn] = useState<Date | undefined>();
  const [checkOut, setCheckOut] = useState<Date | undefined>();
  const [guests, setGuests] = useState(1);
  const [message, setMessage] = useState('');
  const [availability, setAvailability] = useState<AvailabilityBlock[]>([]);
  const [pricing, setPricing] = useState<{
    nights: number;
    pricePerNight: number;
    subtotal: number;
    cleaningFee: number;
    serviceFee: number;
    total: number;
  } | null>(null);
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [showCalendar, setShowCalendar] = useState(false);

  // Load availability
  useEffect(() => {
    const loadAvailability = async () => {
      const startDate = format(new Date(), 'yyyy-MM-dd');
      const endDate = format(addDays(new Date(), 365), 'yyyy-MM-dd');

      try {
        const response = await listingsAPI.getAvailability(listing.id, startDate, endDate);
        setAvailability(response.availability);
      } catch (err) {
        console.error('Failed to load availability:', err);
      }
    };

    loadAvailability();
  }, [listing.id]);

  // Check availability when dates change
  useEffect(() => {
    const checkAvailability = async () => {
      if (!checkIn || !checkOut) {
        setPricing(null);
        setIsAvailable(null);
        return;
      }

      const checkInStr = format(checkIn, 'yyyy-MM-dd');
      const checkOutStr = format(checkOut, 'yyyy-MM-dd');

      try {
        const response = await bookingsAPI.checkAvailability(
          listing.id,
          checkInStr,
          checkOutStr
        );
        setIsAvailable(response.available);
        setPricing(response.pricing);
        setError('');
      } catch (err) {
        console.error('Failed to check availability:', err);
        setIsAvailable(false);
      }
    };

    checkAvailability();
  }, [checkIn, checkOut, listing.id]);

  const handleBook = async () => {
    if (!isAuthenticated) {
      navigate({ to: '/login', search: { redirect: `/listing/${listing.id}` } });
      return;
    }

    if (!checkIn || !checkOut) {
      setError('Please select dates');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const response = await bookingsAPI.create({
        listing_id: listing.id,
        check_in: format(checkIn, 'yyyy-MM-dd'),
        check_out: format(checkOut, 'yyyy-MM-dd'),
        guests,
        message: message || undefined,
      });

      navigate({ to: `/booking/${response.booking.id}` });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Booking failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectDates = (newCheckIn: Date | undefined, newCheckOut: Date | undefined) => {
    setCheckIn(newCheckIn);
    setCheckOut(newCheckOut);
    if (newCheckIn && newCheckOut) {
      setShowCalendar(false);
    }
  };

  return (
    <div className="border border-gray-200 rounded-xl p-6 shadow-lg sticky top-24">
      <div className="flex items-baseline justify-between mb-6">
        <div>
          <span className="text-2xl font-bold">
            {formatCurrency(listing.price_per_night)}
          </span>
          <span className="text-gray-500"> night</span>
        </div>
        {listing.rating && (
          <div className="flex items-center gap-1">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
            </svg>
            <span className="font-medium">{listing.rating}</span>
            <span className="text-gray-500">({listing.review_count} reviews)</span>
          </div>
        )}
      </div>

      {/* Date Selection */}
      <div className="border border-gray-300 rounded-lg mb-4">
        <div className="grid grid-cols-2 divide-x divide-gray-300">
          <button
            onClick={() => setShowCalendar(!showCalendar)}
            className="p-3 text-left hover:bg-gray-50"
          >
            <span className="block text-xs font-bold uppercase">Check-in</span>
            <span className="text-gray-600">
              {checkIn ? format(checkIn, 'MMM d, yyyy') : 'Add date'}
            </span>
          </button>
          <button
            onClick={() => setShowCalendar(!showCalendar)}
            className="p-3 text-left hover:bg-gray-50"
          >
            <span className="block text-xs font-bold uppercase">Checkout</span>
            <span className="text-gray-600">
              {checkOut ? format(checkOut, 'MMM d, yyyy') : 'Add date'}
            </span>
          </button>
        </div>
        <div className="border-t border-gray-300 p-3">
          <span className="block text-xs font-bold uppercase">Guests</span>
          <select
            value={guests}
            onChange={(e) => setGuests(parseInt(e.target.value))}
            className="w-full bg-transparent outline-none"
          >
            {Array.from({ length: listing.max_guests }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? 'guest' : 'guests'}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Calendar */}
      {showCalendar && (
        <div className="mb-4 p-4 border border-gray-200 rounded-lg">
          <Calendar
            availabilityBlocks={availability}
            selectedCheckIn={checkIn}
            selectedCheckOut={checkOut}
            onSelectDates={handleSelectDates}
            minNights={listing.minimum_nights}
          />
        </div>
      )}

      {/* Message for host (non-instant book) */}
      {!listing.instant_book && (
        <div className="mb-4">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Introduce yourself to the host..."
            className="w-full p-3 border border-gray-300 rounded-lg resize-none"
            rows={3}
          />
        </div>
      )}

      {/* Availability status */}
      {isAvailable === false && checkIn && checkOut && (
        <p className="text-red-600 text-sm mb-4">
          These dates are not available. Please try different dates.
        </p>
      )}

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      {/* Book button */}
      <button
        onClick={handleBook}
        disabled={isLoading || !checkIn || !checkOut || isAvailable === false}
        className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isLoading
          ? 'Processing...'
          : !checkIn || !checkOut
          ? 'Check availability'
          : listing.instant_book
          ? 'Reserve'
          : 'Request to book'}
      </button>

      {listing.instant_book && (
        <p className="text-center text-sm text-gray-500 mt-2">
          You won't be charged yet
        </p>
      )}

      {/* Pricing breakdown */}
      {pricing && (
        <div className="mt-6 space-y-3 pt-6 border-t border-gray-200">
          <div className="flex justify-between text-gray-600">
            <span className="underline">
              {formatCurrency(pricing.pricePerNight)} x {pricing.nights} nights
            </span>
            <span>{formatCurrency(pricing.subtotal)}</span>
          </div>
          {pricing.cleaningFee > 0 && (
            <div className="flex justify-between text-gray-600">
              <span className="underline">Cleaning fee</span>
              <span>{formatCurrency(pricing.cleaningFee)}</span>
            </div>
          )}
          <div className="flex justify-between text-gray-600">
            <span className="underline">Service fee</span>
            <span>{formatCurrency(pricing.serviceFee)}</span>
          </div>
          <div className="flex justify-between font-bold pt-3 border-t border-gray-200">
            <span>Total</span>
            <span>{formatCurrency(pricing.total)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
