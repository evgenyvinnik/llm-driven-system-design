import { format, parseISO, differenceInDays } from 'date-fns';

/** Formats an ISO date string to "MMM d, yyyy" format (e.g., "Jan 5, 2024"). */
export function formatDate(dateString: string): string {
  return format(parseISO(dateString), 'MMM d, yyyy');
}

/** Formats an ISO date string to short "MMM d" format (e.g., "Jan 5"). */
export function formatDateShort(dateString: string): string {
  return format(parseISO(dateString), 'MMM d');
}

/** Formats a check-in/check-out date range, combining months when they match. */
export function formatDateRange(checkIn: string, checkOut: string): string {
  const checkInDate = parseISO(checkIn);
  const checkOutDate = parseISO(checkOut);

  if (checkInDate.getMonth() === checkOutDate.getMonth()) {
    return `${format(checkInDate, 'MMM d')} - ${format(checkOutDate, 'd, yyyy')}`;
  }
  return `${format(checkInDate, 'MMM d')} - ${format(checkOutDate, 'MMM d, yyyy')}`;
}

/** Calculates the number of nights between check-in and check-out dates. */
export function getNights(checkIn: string, checkOut: string): number {
  return differenceInDays(parseISO(checkOut), parseISO(checkIn));
}

/**
 * PostgreSQL returns DECIMAL/NUMERIC columns as strings through `pg` (to avoid
 * float precision loss), so monetary values and ratings coming from the API may
 * be a string ("189.00", "4.9") or a number depending on whether the backend
 * computed them in JS. Calling .toFixed() on those strings throws at runtime, so
 * every formatter below coerces first.
 */
type Numeric = number | string | null | undefined;

/** Coerces an API numeric value to a number, defaulting to 0. */
function toNumber(value: Numeric): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/** Formats a number as USD currency without decimal places (e.g., "$120"). */
export function formatCurrency(amount: Numeric): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(toNumber(amount));
}

/** Formats a rating to two decimal places, or returns "New" if no rating exists. */
export function formatRating(rating: Numeric): string {
  const n = toNumber(rating);
  if (!n) return 'New';
  return n.toFixed(2);
}

/** Returns the singular or plural form of a word based on count. */
export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural || `${singular}s`);
}

/** Converts an amenity key (e.g., "air_conditioning") to a human-readable label. */
export function getAmenityLabel(amenity: string): string {
  const labels: Record<string, string> = {
    wifi: 'WiFi',
    kitchen: 'Kitchen',
    air_conditioning: 'Air conditioning',
    heating: 'Heating',
    washer: 'Washer',
    dryer: 'Dryer',
    tv: 'TV',
    pool: 'Pool',
    hot_tub: 'Hot tub',
    parking: 'Free parking',
    gym: 'Gym',
    workspace: 'Dedicated workspace',
    coffee_maker: 'Coffee maker',
    fireplace: 'Fireplace',
    beach_access: 'Beach access',
    doorman: 'Doorman',
    backyard: 'Backyard',
  };
  return labels[amenity] || amenity.replace(/_/g, ' ');
}

/** Converts a property type key to a human-readable label. */
export function getPropertyTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    apartment: 'Apartment',
    house: 'House',
    room: 'Room',
    studio: 'Studio',
    villa: 'Villa',
    cabin: 'Cabin',
    cottage: 'Cottage',
    loft: 'Loft',
  };
  return labels[type] || type;
}

/** Converts a room type key (e.g., "entire_place") to a human-readable label. */
export function getRoomTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    entire_place: 'Entire place',
    private_room: 'Private room',
    shared_room: 'Shared room',
  };
  return labels[type] || type;
}

/** Converts a booking status key to a human-readable label. */
export function getBookingStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: 'Pending',
    confirmed: 'Confirmed',
    cancelled: 'Cancelled',
    completed: 'Completed',
    declined: 'Declined',
  };
  return labels[status] || status;
}

/** Returns Tailwind CSS color classes for a booking status badge. */
export function getBookingStatusColor(status: string): string {
  const colors: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-800',
    confirmed: 'bg-green-100 text-green-800',
    cancelled: 'bg-red-100 text-red-800',
    completed: 'bg-blue-100 text-blue-800',
    declined: 'bg-gray-100 text-gray-800',
  };
  return colors[status] || 'bg-gray-100 text-gray-800';
}
