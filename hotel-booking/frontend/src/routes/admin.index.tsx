import { useState, useEffect } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { Hotel, Booking } from '@/types';
import {
  CreateHotelModal,
  HotelSelector,
  DashboardHotelCard,
  StatsGrid,
  BookingsTable,
} from '@/components/admin';

/**
 * Route configuration for the admin dashboard.
 * Accessible at /admin/
 */
export const Route = createFileRoute('/admin/')({
  component: AdminDashboardPage,
});

/**
 * Main admin dashboard page for hotel administrators.
 * Displays a list of managed hotels, booking statistics, and recent bookings.
 * Provides hotel creation and management functionality.
 *
 * @returns The admin dashboard page
 */
function AdminDashboardPage() {
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading: authLoading } = useAuthStore();

  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [selectedHotel, setSelectedHotel] = useState<string | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [bookingsLoading, setBookingsLoading] = useState(false);
  const [showCreateHotelModal, setShowCreateHotelModal] = useState(false);

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

      loadHotels();
    }
  }, [isAuthenticated, authLoading, user]);

  /**
   * Loads bookings when a hotel is selected.
   */
  useEffect(() => {
    if (selectedHotel) {
      loadBookings(selectedHotel);
    }
  }, [selectedHotel]);

  /**
   * Loads the list of hotels managed by the current user.
   */
  const loadHotels = async () => {
    setLoading(true);
    try {
      const data = await api.getMyHotels();
      setHotels(data);
      if (data.length > 0 && !selectedHotel) {
        setSelectedHotel(data[0].id);
      }
    } catch (err) {
      console.error('Failed to load hotels:', err);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Loads bookings for the specified hotel.
   * @param hotelId - The ID of the hotel to load bookings for
   */
  const loadBookings = async (hotelId: string) => {
    setBookingsLoading(true);
    try {
      const data = await api.getHotelBookings(hotelId);
      setBookings(data);
    } catch (err) {
      console.error('Failed to load bookings:', err);
    } finally {
      setBookingsLoading(false);
    }
  };

  /**
   * Opens the create hotel modal.
   */
  const handleAddHotel = () => {
    setShowCreateHotelModal(true);
  };

  /**
   * Handles successful hotel creation.
   */
  const handleHotelCreated = () => {
    setShowCreateHotelModal(false);
    loadHotels();
  };

  /**
   * Closes the create hotel modal.
   */
  const handleCloseModal = () => {
    setShowCreateHotelModal(false);
  };

  // Find the currently selected hotel object
  const currentHotel = hotels.find((h) => h.id === selectedHotel);

  // Calculate booking statistics
  const stats = calculateBookingStats(bookings);

  // Show loading spinner while auth or data is loading
  if (authLoading || loading) {
    return <LoadingSpinner />;
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <DashboardHeader onAddHotel={handleAddHotel} />

      {hotels.length === 0 ? (
        <EmptyHotelsState onAddHotel={handleAddHotel} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
          {/* Hotel Selector Sidebar */}
          <div className="lg:col-span-1">
            <HotelSelector
              hotels={hotels}
              selectedHotelId={selectedHotel}
              onSelect={setSelectedHotel}
            />
          </div>

          {/* Main Content */}
          <div className="lg:col-span-3 space-y-6">
            {currentHotel && (
              <>
                <DashboardHotelCard hotel={currentHotel} />
                <StatsGrid
                  totalBookings={stats.totalBookings}
                  confirmedBookings={stats.confirmedBookings}
                  pendingBookings={stats.pendingBookings}
                  totalRevenue={stats.totalRevenue}
                />
                <BookingsTable
                  bookings={bookings}
                  isLoading={bookingsLoading}
                  maxRows={10}
                />
              </>
            )}
          </div>
        </div>
      )}

      {/* Create Hotel Modal */}
      {showCreateHotelModal && (
        <CreateHotelModal
          onClose={handleCloseModal}
          onSuccess={handleHotelCreated}
        />
      )}
    </div>
  );
}

/**
 * Booking statistics for the dashboard.
 */
interface BookingStats {
  totalBookings: number;
  confirmedBookings: number;
  pendingBookings: number;
  totalRevenue: number;
}

/**
 * Calculates booking statistics from a list of bookings.
 * @param bookings - The list of bookings to analyze
 * @returns Calculated statistics
 */
function calculateBookingStats(bookings: Booking[]): BookingStats {
  const totalBookings = bookings.length;
  const confirmedBookings = bookings.filter((b) => b.status === 'confirmed').length;
  const pendingBookings = bookings.filter((b) => b.status === 'reserved').length;
  const totalRevenue = bookings
    .filter((b) => b.status === 'confirmed' || b.status === 'completed')
    .reduce((sum, b) => sum + b.totalPrice, 0);

  return { totalBookings, confirmedBookings, pendingBookings, totalRevenue };
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
 * Props for the DashboardHeader component.
 */
interface DashboardHeaderProps {
  /** Callback when "Add New Hotel" is clicked */
  onAddHotel: () => void;
}

/**
 * Dashboard header with title and add hotel button.
 */
function DashboardHeader({ onAddHotel }: DashboardHeaderProps) {
  return (
    <div className="flex justify-between items-center mb-8">
      <h1 className="text-2xl font-bold text-gray-900">Hotel Admin Dashboard</h1>
      <button onClick={onAddHotel} className="btn-primary">
        Add New Hotel
      </button>
    </div>
  );
}

/**
 * Props for the EmptyHotelsState component.
 */
interface EmptyHotelsStateProps {
  /** Callback when "Add Your First Hotel" is clicked */
  onAddHotel: () => void;
}

/**
 * Empty state displayed when the admin has no hotels.
 */
function EmptyHotelsState({ onAddHotel }: EmptyHotelsStateProps) {
  return (
    <div className="text-center py-12 bg-white rounded-xl shadow-sm border">
      <h2 className="text-xl font-medium text-gray-900 mb-2">No Hotels Yet</h2>
      <p className="text-gray-500 mb-4">Start by adding your first property</p>
      <button onClick={onAddHotel} className="btn-primary">
        Add Your First Hotel
      </button>
    </div>
  );
}
