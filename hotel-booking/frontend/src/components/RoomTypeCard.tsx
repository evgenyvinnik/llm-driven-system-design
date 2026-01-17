import type { RoomType } from '@/types';
import { formatCurrency, getAmenityLabel } from '@/utils';

interface RoomTypeCardProps {
  roomType: RoomType;
  nights?: number;
  onSelect?: (roomType: RoomType) => void;
  isSelected?: boolean;
}

export function RoomTypeCard({ roomType, nights = 1, onSelect, isSelected }: RoomTypeCardProps) {
  const isAvailable = !roomType.availability || roomType.availability.available;
  const availableRooms = roomType.availability?.availableRooms ?? roomType.totalCount;
  const totalPrice = roomType.totalPrice ?? roomType.basePrice * nights;
  const pricePerNight = roomType.pricePerNight ?? roomType.basePrice;

  return (
    <div
      className={`card p-4 ${
        isSelected ? 'ring-2 ring-primary-500 border-primary-500' : ''
      } ${!isAvailable ? 'opacity-60' : ''}`}
    >
      <div className="flex flex-col md:flex-row gap-4">
        <div className="md:w-1/3">
          <img
            src={roomType.images?.[0] || 'https://images.unsplash.com/photo-1582719508461-905c673771fd?w=400'}
            alt={roomType.name}
            className="w-full h-40 object-cover rounded-lg"
          />
        </div>
        <div className="md:w-2/3 flex flex-col justify-between">
          <div>
            <div className="flex justify-between items-start mb-2">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">{roomType.name}</h3>
                <p className="text-sm text-gray-500">
                  Up to {roomType.capacity} guests | {roomType.bedType} | {roomType.sizeSqm} m2
                </p>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold text-gray-900">
                  {formatCurrency(totalPrice)}
                </div>
                {nights > 1 && (
                  <div className="text-sm text-gray-500">
                    {formatCurrency(pricePerNight)} / night x {nights} nights
                  </div>
                )}
              </div>
            </div>
            <p className="text-gray-600 text-sm mb-3">{roomType.description}</p>
            <div className="flex flex-wrap gap-1 mb-3">
              {roomType.amenities?.slice(0, 6).map((amenity) => (
                <span
                  key={amenity}
                  className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded"
                >
                  {getAmenityLabel(amenity)}
                </span>
              ))}
            </div>
          </div>
          <div className="flex justify-between items-center">
            <div>
              {isAvailable ? (
                <span className="text-sm text-green-600 font-medium">
                  {availableRooms} room{availableRooms !== 1 ? 's' : ''} left
                </span>
              ) : (
                <span className="text-sm text-red-600 font-medium">Not available</span>
              )}
            </div>
            {onSelect && isAvailable && (
              <button
                onClick={() => onSelect(roomType)}
                className={isSelected ? 'btn-secondary' : 'btn-primary'}
              >
                {isSelected ? 'Selected' : 'Select Room'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
