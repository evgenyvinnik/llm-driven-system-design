import type { OrderWithDetails, OrderStatus } from '@/types';
import { StatusBadge } from '@/components/StatusBadge';

/**
 * Props for the ActiveDeliveryCard component.
 */
interface ActiveDeliveryCardProps {
  /** The order details to display */
  order: OrderWithDetails;
  /** Handler called when the driver marks an order as picked up */
  onPickedUp: (orderId: string) => void;
  /** Handler called when the driver starts the delivery (marks in transit) */
  onInTransit: (orderId: string) => void;
  /** Handler called when the driver marks the order as delivered */
  onDelivered: (orderId: string) => void;
}

/**
 * Configuration for action buttons based on order status.
 */
interface ActionButtonConfig {
  label: string;
  className: string;
  handler: () => void;
}

/**
 * Displays a card for an active delivery order with merchant info,
 * delivery address, order items, and status-appropriate action buttons.
 *
 * The card shows different action buttons based on the current order status:
 * - driver_assigned: "Mark Picked Up" button
 * - picked_up: "Start Delivery" button
 * - in_transit: "Mark Delivered" button
 *
 * @example
 * ```tsx
 * <ActiveDeliveryCard
 *   order={orderData}
 *   onPickedUp={handlePickedUp}
 *   onInTransit={handleInTransit}
 *   onDelivered={handleDelivered}
 * />
 * ```
 */
export function ActiveDeliveryCard({
  order,
  onPickedUp,
  onInTransit,
  onDelivered,
}: ActiveDeliveryCardProps) {
  /**
   * Returns the action button configuration based on the current order status.
   * Returns null if no action is available for the current status.
   */
  const getActionButton = (): ActionButtonConfig | null => {
    const statusActions: Partial<Record<OrderStatus, ActionButtonConfig>> = {
      driver_assigned: {
        label: 'Mark Picked Up',
        className: 'btn-primary flex-1',
        handler: () => onPickedUp(order.id),
      },
      picked_up: {
        label: 'Start Delivery',
        className: 'btn-accent flex-1',
        handler: () => onInTransit(order.id),
      },
      in_transit: {
        label: 'Mark Delivered',
        className: 'btn-primary flex-1 bg-green-600 hover:bg-green-700',
        handler: () => onDelivered(order.id),
      },
    };

    return statusActions[order.status] ?? null;
  };

  /**
   * Formats the order items as a comma-separated string.
   */
  const formatItems = (): string => {
    return order.items.map((i) => `${i.quantity}x ${i.name}`).join(', ');
  };

  const actionButton = getActionButton();

  return (
    <div className="card p-4">
      {/* Merchant info and status */}
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="font-semibold">{order.merchant?.name}</h3>
          <p className="text-sm text-gray-500">{order.merchant?.address}</p>
        </div>
        <StatusBadge status={order.status} />
      </div>

      {/* Delivery address */}
      <div className="mb-4">
        <p className="text-sm text-gray-500">Deliver to</p>
        <p className="font-medium">{order.delivery_address}</p>
        {order.delivery_instructions && (
          <p className="text-sm text-gray-500 mt-1">
            Note: {order.delivery_instructions}
          </p>
        )}
      </div>

      {/* Order items */}
      <div className="mb-4">
        <p className="text-sm text-gray-500">Items ({order.items.length})</p>
        <p className="text-sm">{formatItems()}</p>
      </div>

      {/* Action buttons */}
      {actionButton && (
        <div className="flex gap-3">
          <button
            onClick={actionButton.handler}
            className={actionButton.className}
          >
            {actionButton.label}
          </button>
        </div>
      )}
    </div>
  );
}
