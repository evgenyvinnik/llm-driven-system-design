import type { Driver, DriverStats } from '@/types';

/**
 * Props for the DriverStatusHeader component.
 */
interface DriverStatusHeaderProps {
  /** Combined driver profile and statistics data */
  driver: Driver & DriverStats;
  /** Whether the driver is currently online (available or busy) */
  isOnline: boolean;
  /** Whether a status toggle operation is in progress */
  isTogglingStatus: boolean;
  /** Whether the driver has active orders that prevent going offline */
  hasActiveOrders: boolean;
  /** Handler for going online */
  onGoOnline: () => void;
  /** Handler for going offline */
  onGoOffline: () => void;
}

/**
 * Displays the driver's profile header including name, vehicle type, rating,
 * total deliveries, current status badge, and online/offline toggle button.
 *
 * @example
 * ```tsx
 * <DriverStatusHeader
 *   driver={driverData}
 *   isOnline={true}
 *   isTogglingStatus={false}
 *   hasActiveOrders={false}
 *   onGoOnline={handleGoOnline}
 *   onGoOffline={handleGoOffline}
 * />
 * ```
 */
export function DriverStatusHeader({
  driver,
  isOnline,
  isTogglingStatus,
  hasActiveOrders,
  onGoOnline,
  onGoOffline,
}: DriverStatusHeaderProps) {
  /**
   * Determines the CSS classes for the status badge based on driver status.
   */
  const getStatusBadgeClasses = (): string => {
    if (!isOnline) {
      return 'bg-gray-100 text-gray-600';
    }
    if (driver.status === 'busy') {
      return 'bg-yellow-100 text-yellow-800';
    }
    return 'bg-green-100 text-green-800';
  };

  /**
   * Returns the display text for the current driver status.
   */
  const getStatusText = (): string => {
    if (!isOnline) {
      return 'Offline';
    }
    return driver.status === 'busy' ? 'Busy' : 'Online';
  };

  return (
    <div className="card p-6 mb-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-1">{driver.name}</h1>
          <div className="flex items-center gap-4 text-sm text-gray-500">
            <span className="capitalize">{driver.vehicle_type}</span>
            <span>* {driver.rating.toFixed(2)}</span>
            <span>{driver.total_deliveries} deliveries</span>
          </div>
        </div>

        <div className="text-right">
          <div
            className={`inline-block px-4 py-2 rounded-full font-medium ${getStatusBadgeClasses()}`}
          >
            {getStatusText()}
          </div>
        </div>
      </div>

      <div className="mt-4 pt-4 border-t">
        {isOnline ? (
          <button
            onClick={onGoOffline}
            disabled={isTogglingStatus || hasActiveOrders}
            className="btn-outline w-full"
          >
            {isTogglingStatus ? 'Going offline...' : 'Go Offline'}
          </button>
        ) : (
          <button
            onClick={onGoOnline}
            disabled={isTogglingStatus}
            className="btn-primary w-full"
          >
            {isTogglingStatus ? 'Going online...' : 'Go Online'}
          </button>
        )}
      </div>
    </div>
  );
}
