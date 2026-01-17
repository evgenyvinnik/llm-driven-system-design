import { format, parseISO, differenceInDays, addDays } from 'date-fns';

export function formatDate(date: string | Date, formatStr = 'MMM d, yyyy'): string {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, formatStr);
}

export function formatDateRange(checkIn: string | Date, checkOut: string | Date): string {
  return `${formatDate(checkIn, 'MMM d')} - ${formatDate(checkOut, 'MMM d, yyyy')}`;
}

export function getNights(checkIn: string | Date, checkOut: string | Date): number {
  const start = typeof checkIn === 'string' ? parseISO(checkIn) : checkIn;
  const end = typeof checkOut === 'string' ? parseISO(checkOut) : checkOut;
  return differenceInDays(end, start);
}

export function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function getDateString(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

export function getTodayString(): string {
  return getDateString(new Date());
}

export function getTomorrowString(): string {
  return getDateString(addDays(new Date(), 1));
}

export function getDefaultCheckIn(): string {
  return getDateString(addDays(new Date(), 1));
}

export function getDefaultCheckOut(): string {
  return getDateString(addDays(new Date(), 2));
}

export function generateStars(rating: number): string {
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

export function getAmenityLabel(amenity: string): string {
  const labels: Record<string, string> = {
    wifi: 'Free WiFi',
    pool: 'Swimming Pool',
    gym: 'Fitness Center',
    spa: 'Spa & Wellness',
    restaurant: 'Restaurant',
    bar: 'Bar',
    room_service: 'Room Service',
    parking: 'Parking',
    concierge: 'Concierge',
    beach_access: 'Beach Access',
    water_sports: 'Water Sports',
    ski_access: 'Ski Access',
    fireplace: 'Fireplace',
    hot_tub: 'Hot Tub',
    ski_storage: 'Ski Storage',
    art_gallery: 'Art Gallery',
    rooftop_terrace: 'Rooftop Terrace',
    garden: 'Garden',
    library: 'Library',
    tv: 'TV',
    minibar: 'Minibar',
    safe: 'In-room Safe',
    bathtub: 'Bathtub',
    living_room: 'Living Room',
    dining_room: 'Dining Room',
    butler_service: 'Butler Service',
    balcony: 'Balcony',
    kitchen: 'Kitchen',
    private_pool: 'Private Pool',
    artwork: 'Original Artwork',
    sitting_area: 'Sitting Area',
  };
  return labels[amenity] || amenity.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getStatusColor(status: string): string {
  switch (status) {
    case 'confirmed':
      return 'bg-green-100 text-green-800';
    case 'reserved':
      return 'bg-yellow-100 text-yellow-800';
    case 'completed':
      return 'bg-blue-100 text-blue-800';
    case 'cancelled':
      return 'bg-red-100 text-red-800';
    case 'expired':
      return 'bg-gray-100 text-gray-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}

export function getStatusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
