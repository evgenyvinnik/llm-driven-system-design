import type { Order } from '../types';
import { formatPrice, formatDate } from '../utils/format';

interface OrderHistoryProps {
  orders: Order[];
  onCancel: (orderId: string) => Promise<void>;
}

/** Renders a table of user orders with status badges, fill details, and cancel actions. */
export function OrderHistory({ orders, onCancel }: OrderHistoryProps) {
  if (orders.length === 0) {
    return (
      <div className="bg-cb-card rounded-xl border border-cb-border p-8 text-center">
        <p className="text-cb-text-secondary">No orders yet</p>
        <p className="text-cb-text-secondary text-sm mt-1">
          Place your first order on any trading pair
        </p>
      </div>
    );
  }

  return (
    <div className="bg-cb-card rounded-xl border border-cb-border overflow-hidden">
      {/* Header */}
      <div className="grid grid-cols-8 gap-2 px-4 py-3 border-b border-cb-border text-xs text-cb-text-secondary font-medium uppercase tracking-wider">
        <div>Pair</div>
        <div>Side</div>
        <div>Type</div>
        <div className="text-right">Qty</div>
        <div className="text-right">Price</div>
        <div className="text-right">Filled</div>
        <div>Status</div>
        <div className="text-right">Action</div>
      </div>

      {/* Orders */}
      {orders.map((order) => (
        <div
          key={order.id}
          className="grid grid-cols-8 gap-2 px-4 py-3 border-b border-cb-border last:border-b-0 text-sm items-center hover:bg-cb-surface/30"
        >
          <div className="font-medium">{order.symbol}</div>
          <div>
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded ${
                order.side === 'buy'
                  ? 'bg-cb-green/10 text-cb-green'
                  : 'bg-cb-red/10 text-cb-red'
              }`}
            >
              {order.side.toUpperCase()}
            </span>
          </div>
          <div className="text-cb-text-secondary capitalize">{order.orderType}</div>
          <div className="text-right">
            {typeof order.quantity === 'string'
              ? parseFloat(order.quantity as unknown as string).toFixed(4)
              : order.quantity.toFixed(4)}
          </div>
          <div className="text-right">
            {order.price
              ? `$${formatPrice(typeof order.price === 'string' ? parseFloat(order.price as unknown as string) : order.price, 2)}`
              : order.stopPrice
                ? <span title="Becomes a market order when the price reaches this level">Stop ${formatPrice(parseFloat(order.stopPrice), 2)}</span>
                : 'Market'}
          </div>
          <div className="text-right">
            {typeof order.filledQuantity === 'string'
              ? parseFloat(order.filledQuantity as unknown as string).toFixed(4)
              : order.filledQuantity.toFixed(4)}
            {order.avgFillPrice && (
              <span className="text-cb-text-secondary text-xs block">
                @ ${formatPrice(typeof order.avgFillPrice === 'string' ? parseFloat(order.avgFillPrice as unknown as string) : order.avgFillPrice, 2)}
              </span>
            )}
          </div>
          <div>
            <StatusBadge status={order.status} />
          </div>
          <div className="text-right">
            {(order.status === 'open' || order.status === 'partially_filled') && (
              <button
                onClick={() => onCancel(order.id)}
                className="text-xs text-cb-red hover:text-cb-red/80 transition-colors"
              >
                Cancel
              </button>
            )}
            {order.status !== 'open' && order.status !== 'partially_filled' && (
              <span className="text-xs text-cb-text-secondary">
                {formatDate(order.createdAt)}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'bg-cb-yellow/10 text-cb-yellow',
    open: 'bg-cb-primary/10 text-cb-primary',
    partially_filled: 'bg-cb-yellow/10 text-cb-yellow',
    filled: 'bg-cb-green/10 text-cb-green',
    cancelled: 'bg-cb-text-secondary/10 text-cb-text-secondary',
    rejected: 'bg-cb-red/10 text-cb-red',
  };

  const labels: Record<string, string> = {
    pending: 'Pending',
    open: 'Open',
    partially_filled: 'Partial',
    filled: 'Filled',
    cancelled: 'Cancelled',
    rejected: 'Rejected',
  };

  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded ${styles[status] || ''}`}>
      {labels[status] || status}
    </span>
  );
}
