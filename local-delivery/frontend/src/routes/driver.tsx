import { createFileRoute } from '@tanstack/react-router';
import { useDriverDashboard } from '@/hooks/useDriverDashboard';
import { PageLoading } from '@/components/LoadingSpinner';
import {
  DriverStatusHeader,
  DriverStatsGrid,
  ActiveDeliveryCard,
  DeliveryOfferModal,
} from '@/components/driver';

export const Route = createFileRoute('/driver')({
  component: DriverDashboard,
});

/**
 * Driver dashboard page component.
 *
 * Displays the driver's profile, statistics, active deliveries, and handles
 * real-time delivery offer notifications. Allows drivers to:
 * - Toggle online/offline status
 * - View and respond to delivery offers
 * - Manage active delivery orders (mark picked up, in transit, delivered)
 *
 * Uses the useDriverDashboard hook for all state management and business logic.
 */
function DriverDashboard() {
  const {
    driver,
    orders,
    pendingOffer,
    isLoading,
    isTogglingStatus,
    isOnline,
    handleGoOnline,
    handleGoOffline,
    handleAcceptOffer,
    handleRejectOffer,
    handlePickedUp,
    handleInTransit,
    handleDelivered,
  } = useDriverDashboard();

  if (isLoading) {
    return <PageLoading />;
  }

  if (!driver) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Driver profile not found</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Pending Offer Modal */}
      {pendingOffer && (
        <DeliveryOfferModal
          pendingOffer={pendingOffer}
          onAccept={handleAcceptOffer}
          onDecline={handleRejectOffer}
        />
      )}

      {/* Driver Status Header */}
      <DriverStatusHeader
        driver={driver}
        isOnline={isOnline}
        isTogglingStatus={isTogglingStatus}
        hasActiveOrders={orders.length > 0}
        onGoOnline={handleGoOnline}
        onGoOffline={handleGoOffline}
      />

      {/* Stats Grid */}
      <DriverStatsGrid stats={driver} />

      {/* Active Deliveries Section */}
      <ActiveDeliveriesSection
        orders={orders}
        isOnline={isOnline}
        onPickedUp={handlePickedUp}
        onInTransit={handleInTransit}
        onDelivered={handleDelivered}
      />
    </div>
  );
}

/**
 * Props for the ActiveDeliveriesSection component.
 */
interface ActiveDeliveriesSectionProps {
  /** List of active delivery orders */
  orders: Parameters<typeof ActiveDeliveryCard>[0]['order'][];
  /** Whether the driver is currently online */
  isOnline: boolean;
  /** Handler for marking an order as picked up */
  onPickedUp: (orderId: string) => void;
  /** Handler for marking an order as in transit */
  onInTransit: (orderId: string) => void;
  /** Handler for marking an order as delivered */
  onDelivered: (orderId: string) => void;
}

/**
 * Section component that displays the list of active deliveries or an
 * appropriate empty state message based on the driver's online status.
 */
function ActiveDeliveriesSection({
  orders,
  isOnline,
  onPickedUp,
  onInTransit,
  onDelivered,
}: ActiveDeliveriesSectionProps) {
  /**
   * Returns the appropriate empty state message based on online status.
   */
  const getEmptyMessage = (): string => {
    return isOnline
      ? 'Waiting for orders...'
      : 'Go online to receive delivery requests';
  };

  return (
    <div className="mb-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Active Deliveries</h2>

      {orders.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-gray-500">{getEmptyMessage()}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {orders.map((order) => (
            <ActiveDeliveryCard
              key={order.id}
              order={order}
              onPickedUp={onPickedUp}
              onInTransit={onInTransit}
              onDelivered={onDelivered}
            />
          ))}
        </div>
      )}
    </div>
  );
}
