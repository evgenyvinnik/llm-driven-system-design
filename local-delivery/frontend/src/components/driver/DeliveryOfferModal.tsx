import type { OrderWithDetails, DriverOffer } from '@/types';

/**
 * Represents a pending delivery offer with countdown timer.
 */
export interface PendingOffer {
  /** The driver offer details */
  offer: DriverOffer;
  /** The order details associated with the offer */
  order: OrderWithDetails;
  /** Seconds remaining before the offer expires */
  expiresIn: number;
}

/**
 * Props for the DeliveryOfferModal component.
 */
interface DeliveryOfferModalProps {
  /** The pending offer to display */
  pendingOffer: PendingOffer;
  /** Handler called when the driver accepts the offer */
  onAccept: () => void;
  /** Handler called when the driver declines the offer */
  onDecline: () => void;
}

/**
 * A modal dialog that displays a new delivery request to the driver.
 * Shows restaurant info, delivery address, item count, potential payout,
 * and a countdown timer. The driver can accept or decline the offer.
 *
 * The modal automatically closes when the countdown reaches zero
 * (handled by the parent component).
 *
 * @example
 * ```tsx
 * {pendingOffer && (
 *   <DeliveryOfferModal
 *     pendingOffer={pendingOffer}
 *     onAccept={handleAcceptOffer}
 *     onDecline={handleRejectOffer}
 *   />
 * )}
 * ```
 */
export function DeliveryOfferModal({
  pendingOffer,
  onAccept,
  onDecline,
}: DeliveryOfferModalProps) {
  const { order, expiresIn } = pendingOffer;

  /**
   * Calculates the total payout for the driver (delivery fee + tip).
   */
  const calculatePayout = (): string => {
    return (order.delivery_fee + order.tip).toFixed(2);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 max-w-lg w-full mx-4 shadow-2xl">
        {/* Header with countdown */}
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">New Delivery Request</h2>
          <div className="text-2xl font-bold text-accent-600">
            {expiresIn}s
          </div>
        </div>

        {/* Offer details */}
        <div className="space-y-4 mb-6">
          {/* Restaurant info */}
          <div>
            <p className="text-sm text-gray-500">Restaurant</p>
            <p className="font-medium">{order.merchant?.name}</p>
            <p className="text-sm text-gray-500">{order.merchant?.address}</p>
          </div>

          {/* Delivery destination */}
          <div>
            <p className="text-sm text-gray-500">Deliver to</p>
            <p className="font-medium">{order.delivery_address}</p>
          </div>

          {/* Items and payout */}
          <div className="flex justify-between">
            <div>
              <p className="text-sm text-gray-500">Items</p>
              <p>{order.items.length} items</p>
            </div>
            <div className="text-right">
              <p className="text-sm text-gray-500">Payout</p>
              <p className="font-semibold text-lg text-green-600">
                ${calculatePayout()}
              </p>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-4">
          <button
            onClick={onDecline}
            className="btn-outline flex-1"
          >
            Decline
          </button>
          <button
            onClick={onAccept}
            className="btn-primary flex-1"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
