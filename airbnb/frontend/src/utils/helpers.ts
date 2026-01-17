import { format, parseISO, differenceInDays } from 'date-fns';

export function formatDate(dateString: string): string {
  return format(parseISO(dateString), 'MMM d, yyyy');
}

export function formatDateShort(dateString: string): string {
  return format(parseISO(dateString), 'MMM d');
}

export function formatDateRange(checkIn: string, checkOut: string): string {
  const checkInDate = parseISO(checkIn);
  const checkOutDate = parseISO(checkOut);

  if (checkInDate.getMonth() === checkOutDate.getMonth()) {
    return `${format(checkInDate, 'MMM d')} - ${format(checkOutDate, 'd, yyyy')}`;
  }
  return `${format(checkInDate, 'MMM d')} - ${format(checkOutDate, 'MMM d, yyyy')}`;
}

export function getNights(checkIn: string, checkOut: string): number {
  return differenceInDays(parseISO(checkOut), parseISO(checkIn));
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatRating(rating: number | undefined | null): string {
  if (!rating) return 'New';
  return rating.toFixed(2);
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural || `${singular}s`);
}

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

export function getRoomTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    entire_place: 'Entire place',
    private_room: 'Private room',
    shared_room: 'Shared room',
  };
  return labels[type] || type;
}

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
