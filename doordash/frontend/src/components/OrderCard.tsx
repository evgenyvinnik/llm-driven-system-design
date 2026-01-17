import type { Order } from '../types';

/**
 * Props for the OrderCard component.
 */
interface Props {
  /** Order data to display */
  order: Order;
  /** Whether to show detailed order information (items, pricing, address) */
  showDetails?: boolean;
  /** Callback when status update button is clicked */
  onStatusUpdate?: (status: string) => void;
  /** User role determines available status transitions */
  userRole?: 'customer' | 'restaurant' | 'driver';
}

/**
 * Color mapping for order status badges.
 * Each status has a corresponding Tailwind color class.
 */
const STATUS_COLORS: Record<string, string> = {
  PLACED: 'bg-yellow-100 text-yellow-800',
  CONFIRMED: 'bg-blue-100 text-blue-800',
  PREPARING: 'bg-orange-100 text-orange-800',
  READY_FOR_PICKUP: 'bg-purple-100 text-purple-800',
  PICKED_UP: 'bg-indigo-100 text-indigo-800',
  DELIVERED: 'bg-green-100 text-green-800',
  COMPLETED: 'bg-gray-100 text-gray-800',
  CANCELLED: 'bg-red-100 text-red-800',
};

/**
 * Human-readable labels for order statuses.
 */
const STATUS_LABELS: Record<string, string> = {
  PLACED: 'Order Placed',
  CONFIRMED: 'Confirmed',
  PREPARING: 'Preparing',
  READY_FOR_PICKUP: 'Ready for Pickup',
  PICKED_UP: 'Picked Up',
  DELIVERED: 'Delivered',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

/**
 * Order card component for displaying order information.
 * Shows order summary with optional detailed view including items,
 * pricing breakdown, delivery address, and driver information.
 *
 * Features:
 * - Status badge with color coding
 * - ETA display for active orders
 * - Detailed view with items and pricing breakdown
 * - Status update button based on user role
 * - ETA breakdown showing time components
 *
 * The component adapts its display and actions based on:
 * - showDetails: Controls visibility of item list and pricing
 * - userRole: Determines which status transitions are available
 * - onStatusUpdate: Enables the action button when provided
 *
 * @param props - Component props
 * @returns React component rendering an order card
 */
export function OrderCard({ order, showDetails = false, onStatusUpdate, userRole = 'customer' }: Props) {
  const formatTime = (dateStr: string) => {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  const getNextStatus = (): string | null => {
    if (userRole === 'restaurant') {
      switch (order.status) {
        case 'PLACED': return 'CONFIRMED';
        case 'CONFIRMED': return 'PREPARING';
        case 'PREPARING': return 'READY_FOR_PICKUP';
        default: return null;
      }
    }
    if (userRole === 'driver') {
      switch (order.status) {
        case 'READY_FOR_PICKUP': return 'PICKED_UP';
        case 'PICKED_UP': return 'DELIVERED';
        default: return null;
      }
    }
    return null;
  };

  const nextStatus = getNextStatus();
  const nextStatusLabel = nextStatus ? STATUS_LABELS[nextStatus] : null;

  return (
    <div className="bg-white rounded-lg shadow-sm p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-gray-900">
              Order #{order.id}
            </h3>
            <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[order.status]}`}>
              {STATUS_LABELS[order.status]}
            </span>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            {order.restaurant_name || order.restaurant?.name}
          </p>
          <p className="text-sm text-gray-400">
            {formatDate(order.placed_at)} at {formatTime(order.placed_at)}
          </p>
        </div>
        <div className="text-right">
          <p className="font-semibold text-gray-900">${Number(order.total).toFixed(2)}</p>
          {order.estimated_delivery_at && !['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(order.status) && (
            <p className="text-sm text-gray-500">
              ETA: {formatTime(order.estimated_delivery_at)}
            </p>
          )}
        </div>
      </div>

      {showDetails && (
        <>
          <div className="border-t mt-4 pt-4">
            <h4 className="font-medium text-gray-900 mb-2">Items</h4>
            <ul className="space-y-1">
              {order.items?.map((item) => (
                <li key={item.id} className="flex justify-between text-sm">
                  <span>
                    {item.quantity}x {item.name}
                  </span>
                  <span className="text-gray-500">${(Number(item.price) * item.quantity).toFixed(2)}</span>
                </li>
              ))}
            </ul>
            <div className="border-t mt-3 pt-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Subtotal</span>
                <span>${Number(order.subtotal).toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Delivery Fee</span>
                <span>${Number(order.delivery_fee).toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Tax</span>
                <span>${Number(order.tax).toFixed(2)}</span>
              </div>
              {Number(order.tip) > 0 && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Tip</span>
                  <span>${Number(order.tip).toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between font-semibold pt-2 border-t">
                <span>Total</span>
                <span>${Number(order.total).toFixed(2)}</span>
              </div>
            </div>
          </div>

          {order.delivery_address && (
            <div className="border-t mt-4 pt-4">
              <h4 className="font-medium text-gray-900 mb-1">Delivery Address</h4>
              <p className="text-sm text-gray-600">{order.delivery_address.address}</p>
              {order.delivery_instructions && (
                <p className="text-sm text-gray-500 mt-1">Note: {order.delivery_instructions}</p>
              )}
            </div>
          )}

          {order.driver && (
            <div className="border-t mt-4 pt-4">
              <h4 className="font-medium text-gray-900 mb-1">Driver</h4>
              <p className="text-sm text-gray-600">{order.driver.name}</p>
              {order.driver.phone && (
                <p className="text-sm text-gray-500">{order.driver.phone}</p>
              )}
            </div>
          )}

          {order.eta_breakdown && !['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(order.status) && (
            <div className="border-t mt-4 pt-4">
              <h4 className="font-medium text-gray-900 mb-2">ETA Breakdown</h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="text-gray-500">Driver to restaurant</div>
                <div>{order.eta_breakdown.toRestaurantMinutes} min</div>
                <div className="text-gray-500">Preparation</div>
                <div>{order.eta_breakdown.prepTimeMinutes} min</div>
                <div className="text-gray-500">Delivery</div>
                <div>{order.eta_breakdown.deliveryMinutes} min</div>
                <div className="text-gray-500 font-medium">Total</div>
                <div className="font-medium">{order.eta_breakdown.totalMinutes} min</div>
              </div>
            </div>
          )}
        </>
      )}

      {onStatusUpdate && nextStatus && (
        <div className="mt-4 pt-4 border-t">
          <button
            onClick={() => onStatusUpdate(nextStatus)}
            className="w-full bg-doordash-red text-white py-2 rounded-lg font-medium hover:bg-doordash-darkRed transition"
          >
            Mark as {nextStatusLabel}
          </button>
        </div>
      )}
    </div>
  );
}
