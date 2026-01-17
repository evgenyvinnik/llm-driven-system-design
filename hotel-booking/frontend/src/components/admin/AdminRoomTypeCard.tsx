import type { RoomType } from '@/types';
import { formatCurrency, getAmenityLabel } from '@/utils';

/** Default room image URL when no images are available. */
const DEFAULT_ROOM_IMAGE = 'https://images.unsplash.com/photo-1582719508461-905c673771fd?w=200';

/**
 * Props for the AdminRoomTypeCard component.
 */
interface AdminRoomTypeCardProps {
  /** The room type to display */
  room: RoomType;
  /** Callback when "Manage Pricing" is clicked */
  onManagePricing: (roomId: string) => void;
  /** Callback when "Edit" is clicked */
  onEdit: (room: RoomType) => void;
  /** Callback when "Delete" is clicked */
  onDelete: (roomId: string) => void;
}

/**
 * Card component for displaying a room type in the admin hotel management page.
 * Shows room details including image, name, capacity, pricing, amenities,
 * and action buttons for management.
 *
 * @param props - Component props
 * @returns A card for managing a room type
 *
 * @example
 * ```tsx
 * <AdminRoomTypeCard
 *   room={room}
 *   onManagePricing={(id) => openPricingModal(id)}
 *   onEdit={(room) => openEditModal(room)}
 *   onDelete={(id) => handleDelete(id)}
 * />
 * ```
 */
export function AdminRoomTypeCard({
  room,
  onManagePricing,
  onEdit,
  onDelete,
}: AdminRoomTypeCardProps) {
  const imageUrl = room.images?.[0] || DEFAULT_ROOM_IMAGE;

  return (
    <div className="border rounded-lg p-4">
      <div className="flex flex-col md:flex-row gap-4">
        <RoomImage src={imageUrl} alt={room.name} />
        <div className="flex-1">
          <RoomDetails room={room} />
          <RoomDescription description={room.description} />
          <RoomAmenities amenities={room.amenities} />
          <RoomActions
            room={room}
            onManagePricing={onManagePricing}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Displays the room thumbnail image.
 */
function RoomImage({ src, alt }: { src: string; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
      className="w-full md:w-32 h-32 object-cover rounded-lg"
    />
  );
}

/**
 * Displays room name, specs, and pricing.
 */
function RoomDetails({ room }: { room: RoomType }) {
  return (
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
  );
}

/**
 * Displays room description text.
 */
function RoomDescription({ description }: { description?: string }) {
  if (!description) return null;
  return <p className="text-gray-600 text-sm mt-2">{description}</p>;
}

/**
 * Displays a truncated list of room amenities.
 */
function RoomAmenities({ amenities }: { amenities?: string[] }) {
  if (!amenities || amenities.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1 mt-2">
      {amenities.slice(0, 5).map((amenity) => (
        <span key={amenity} className="bg-gray-100 text-gray-600 px-2 py-0.5 rounded text-xs">
          {getAmenityLabel(amenity)}
        </span>
      ))}
    </div>
  );
}

/**
 * Props for the RoomActions component.
 */
interface RoomActionsProps {
  room: RoomType;
  onManagePricing: (roomId: string) => void;
  onEdit: (room: RoomType) => void;
  onDelete: (roomId: string) => void;
}

/**
 * Displays room count and action buttons (pricing, edit, delete).
 */
function RoomActions({ room, onManagePricing, onEdit, onDelete }: RoomActionsProps) {
  return (
    <div className="flex items-center justify-between mt-4">
      <div className="text-sm text-gray-500">
        {room.totalCount} rooms total
      </div>
      <div className="flex space-x-2">
        <button
          onClick={() => onManagePricing(room.id)}
          className="text-sm text-primary-600 hover:text-primary-700"
        >
          Manage Pricing
        </button>
        <button
          onClick={() => onEdit(room)}
          className="text-sm text-gray-600 hover:text-gray-700"
        >
          Edit
        </button>
        <button
          onClick={() => onDelete(room.id)}
          className="text-sm text-red-600 hover:text-red-700"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
