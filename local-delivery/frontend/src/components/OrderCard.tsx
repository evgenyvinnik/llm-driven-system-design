import type { OrderWithDetails } from '@/types';
import { StatusBadge } from './StatusBadge';
import { Link } from '@tanstack/react-router';

interface OrderCardProps {
  order: OrderWithDetails;
  showDetails?: boolean;
}

export function OrderCard({ order, showDetails = false }: OrderCardProps) {
  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString();
  };

  return (
    <Link
      to="/orders/$orderId"
      params={{ orderId: order.id }}
      className="card p-4 hover:shadow-md transition-shadow block"
    >
      <div className="flex justify-between items-start mb-3">
        <div>
          <h3 className="font-semibold text-gray-900">
            {order.merchant?.name || 'Order'}
          </h3>
          <p className="text-sm text-gray-500">
            {formatDate(order.created_at)}
          </p>
        </div>
        <StatusBadge status={order.status} />
      </div>

      {showDetails && order.items && (
        <div className="mb-3">
          <p className="text-sm text-gray-600">
            {order.items.map((item) => `${item.quantity}x ${item.name}`).join(', ')}
          </p>
        </div>
      )}

      <div className="flex justify-between items-center">
        <span className="text-sm text-gray-600">{order.delivery_address}</span>
        <span className="font-semibold text-gray-900">
          ${order.total.toFixed(2)}
        </span>
      </div>

      {order.driver && order.status !== 'delivered' && order.status !== 'cancelled' && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          <div className="flex items-center gap-2 text-sm">
            <span>🚗</span>
            <span className="text-gray-600">
              {order.driver.name} ({order.driver.vehicle_type})
            </span>
            <span className="text-gray-400">⭐ {order.driver.rating.toFixed(1)}</span>
          </div>
        </div>
      )}

      {order.estimated_delivery_time && order.status !== 'delivered' && order.status !== 'cancelled' && (
        <div className="mt-2 text-sm text-accent-600">
          ETA: {new Date(order.estimated_delivery_time).toLocaleTimeString()}
        </div>
      )}
    </Link>
  );
}
