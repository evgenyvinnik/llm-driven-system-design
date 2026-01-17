import type { Hotel } from '@/types';

/**
 * Props for the HotelSelector component.
 */
interface HotelSelectorProps {
  /** List of hotels to display in the selector */
  hotels: Hotel[];
  /** Currently selected hotel ID */
  selectedHotelId: string | null;
  /** Callback when a hotel is selected */
  onSelect: (hotelId: string) => void;
}

/**
 * Sidebar component for selecting which hotel to manage.
 * Displays a list of the admin's properties with the selected one highlighted.
 *
 * @param props - Component props
 * @returns A sidebar card with hotel selection buttons
 *
 * @example
 * ```tsx
 * <HotelSelector
 *   hotels={hotels}
 *   selectedHotelId={selectedHotel}
 *   onSelect={(id) => setSelectedHotel(id)}
 * />
 * ```
 */
export function HotelSelector({ hotels, selectedHotelId, onSelect }: HotelSelectorProps) {
  return (
    <div className="card p-4">
      <h2 className="font-semibold mb-4">Your Properties</h2>
      <div className="space-y-2">
        {hotels.map((hotel) => (
          <HotelSelectorItem
            key={hotel.id}
            hotel={hotel}
            isSelected={selectedHotelId === hotel.id}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Props for the HotelSelectorItem component.
 */
interface HotelSelectorItemProps {
  /** The hotel to display */
  hotel: Hotel;
  /** Whether this hotel is currently selected */
  isSelected: boolean;
  /** Callback when this hotel is selected */
  onSelect: (hotelId: string) => void;
}

/**
 * Individual hotel item in the selector sidebar.
 */
function HotelSelectorItem({ hotel, isSelected, onSelect }: HotelSelectorItemProps) {
  const baseClasses = 'w-full text-left p-3 rounded-lg transition-colors';
  const selectedClasses = 'bg-primary-50 border-primary-200 border';
  const unselectedClasses = 'hover:bg-gray-50';

  return (
    <button
      onClick={() => onSelect(hotel.id)}
      className={`${baseClasses} ${isSelected ? selectedClasses : unselectedClasses}`}
    >
      <p className="font-medium text-gray-900">{hotel.name}</p>
      <p className="text-sm text-gray-500">{hotel.city}</p>
    </button>
  );
}
