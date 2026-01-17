import { useState, useEffect } from 'react';
import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { Hotel, RoomType } from '@/types';
import { ChevronLeftIcon } from '@/components/icons';
import {
  RoomTypeModal,
  PricingModal,
  HotelHeader,
  AdminRoomTypeCard,
} from '@/components/admin';

/**
 * Route configuration for the hotel management page.
 * Accessible at /admin/hotels/:hotelId
 */
export const Route = createFileRoute('/admin/hotels/$hotelId')({
  component: ManageHotelPage,
});

/**
 * Page component for managing a specific hotel.
 * Allows hotel admins to view hotel details and manage room types,
 * including adding, editing, deleting rooms and managing pricing.
 *
 * @returns The hotel management page
 */
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

  /**
   * Checks authentication and authorization on mount.
   * Redirects to login if not authenticated, or home if not an admin.
   */
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

  /**
   * Loads the hotel data from the API.
   */
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

  /**
   * Handles deletion of a room type.
   * Shows confirmation dialog before deleting.
   * @param roomId - The ID of the room type to delete
   */
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

  /**
   * Opens the pricing modal for a specific room type.
   * @param roomId - The ID of the room type to manage pricing for
   */
  const handleManagePricing = (roomId: string) => {
    setPricingRoomId(roomId);
    setShowPricingModal(true);
  };

  /**
   * Opens the edit modal for a specific room type.
   * @param room - The room type to edit
   */
  const handleEditRoom = (room: RoomType) => {
    setEditingRoom(room);
    setShowRoomModal(true);
  };

  /**
   * Opens the modal for adding a new room type.
   */
  const handleAddRoom = () => {
    setEditingRoom(null);
    setShowRoomModal(true);
  };

  /**
   * Handles successful save of a room type.
   */
  const handleRoomSaveSuccess = () => {
    setShowRoomModal(false);
    setEditingRoom(null);
    loadHotel();
  };

  /**
   * Closes the room type modal.
   */
  const handleRoomModalClose = () => {
    setShowRoomModal(false);
    setEditingRoom(null);
  };

  /**
   * Closes the pricing modal.
   */
  const handlePricingModalClose = () => {
    setShowPricingModal(false);
    setPricingRoomId(null);
  };

  // Show loading spinner while auth or data is loading
  if (authLoading || loading) {
    return <LoadingSpinner />;
  }

  // Show error state if hotel could not be loaded
  if (error || !hotel) {
    return <ErrorState error={error} />;
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <BackToDashboardLink />
      <HotelHeader hotel={hotel} />
      <RoomTypesSection
        roomTypes={hotel.roomTypes}
        onAddRoom={handleAddRoom}
        onManagePricing={handleManagePricing}
        onEditRoom={handleEditRoom}
        onDeleteRoom={handleDeleteRoom}
      />

      {/* Room Modal */}
      {showRoomModal && (
        <RoomTypeModal
          hotelId={hotelId}
          room={editingRoom}
          onClose={handleRoomModalClose}
          onSuccess={handleRoomSaveSuccess}
        />
      )}

      {/* Pricing Modal */}
      {showPricingModal && pricingRoomId && (
        <PricingModal
          roomTypeId={pricingRoomId}
          onClose={handlePricingModalClose}
        />
      )}
    </div>
  );
}

/**
 * Displays a loading spinner while data is being fetched.
 */
function LoadingSpinner() {
  return (
    <div className="flex justify-center py-12">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
    </div>
  );
}

/**
 * Displays an error state with a link back to the dashboard.
 */
function ErrorState({ error }: { error: string | null }) {
  return (
    <div className="text-center py-12">
      <p className="text-red-600">{error || 'Hotel not found'}</p>
      <Link to="/admin" className="btn-primary mt-4">
        Back to Dashboard
      </Link>
    </div>
  );
}

/**
 * Navigation link back to the admin dashboard.
 */
function BackToDashboardLink() {
  return (
    <Link
      to="/admin"
      className="text-primary-600 hover:text-primary-700 mb-4 inline-flex items-center"
    >
      <ChevronLeftIcon className="w-4 h-4 mr-1" />
      Back to Dashboard
    </Link>
  );
}

/**
 * Props for the RoomTypesSection component.
 */
interface RoomTypesSectionProps {
  /** List of room types for the hotel */
  roomTypes?: RoomType[];
  /** Callback to open the add room modal */
  onAddRoom: () => void;
  /** Callback when pricing management is requested */
  onManagePricing: (roomId: string) => void;
  /** Callback when room edit is requested */
  onEditRoom: (room: RoomType) => void;
  /** Callback when room deletion is requested */
  onDeleteRoom: (roomId: string) => void;
}

/**
 * Section displaying all room types for a hotel with management actions.
 */
function RoomTypesSection({
  roomTypes,
  onAddRoom,
  onManagePricing,
  onEditRoom,
  onDeleteRoom,
}: RoomTypesSectionProps) {
  const hasRooms = roomTypes && roomTypes.length > 0;

  return (
    <div className="card p-6">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold">Room Types</h2>
        <button onClick={onAddRoom} className="btn-primary">
          Add Room Type
        </button>
      </div>

      {hasRooms ? (
        <div className="space-y-4">
          {roomTypes.map((room) => (
            <AdminRoomTypeCard
              key={room.id}
              room={room}
              onManagePricing={onManagePricing}
              onEdit={onEditRoom}
              onDelete={onDeleteRoom}
            />
          ))}
        </div>
      ) : (
        <EmptyRoomsState />
      )}
    </div>
  );
}

/**
 * Displays a message when no room types exist for the hotel.
 */
function EmptyRoomsState() {
  return (
    <div className="text-center py-8 text-gray-500">
      No room types yet. Add your first room type to start accepting bookings.
    </div>
  );
}
