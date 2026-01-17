/**
 * Alert notification item component.
 * Displays price drop alerts with icons, messages, and actions.
 * @module components/AlertItem
 */
import { Alert } from '../types';
import { formatDistanceToNow } from 'date-fns';

/** Props for the AlertItem component */
interface AlertItemProps {
  /** Alert data to display */
  alert: Alert;
  /** Optional callback when mark as read is clicked */
  onMarkRead?: (id: string) => void;
  /** Optional callback when delete is clicked */
  onDelete?: (id: string) => void;
}

/**
 * Renders a single alert notification with icon, message, and actions.
 * Different icons and messages for target reached, price drop, and back in stock.
 * Shows price change percentage when applicable.
 * @param props - Component props
 */
export function AlertItem({ alert, onMarkRead, onDelete }: AlertItemProps) {
  const formatPrice = (price: number | null) => {
    if (price === null) return 'N/A';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(price);
  };

  const getAlertIcon = (type: string) => {
    switch (type) {
      case 'target_reached':
        return (
          <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
            <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
        );
      case 'price_drop':
        return (
          <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
            <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
          </div>
        );
      case 'back_in_stock':
        return (
          <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center">
            <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
          </div>
        );
      default:
        return null;
    }
  };

  const getAlertMessage = () => {
    switch (alert.alert_type) {
      case 'target_reached':
        return `Price dropped to your target! Now ${formatPrice(alert.new_price)}`;
      case 'price_drop':
        return `Price dropped from ${formatPrice(alert.old_price)} to ${formatPrice(alert.new_price)}`;
      case 'back_in_stock':
        return `Product is back in stock at ${formatPrice(alert.new_price)}`;
      default:
        return 'Price alert';
    }
  };

  const priceChange = alert.old_price
    ? ((alert.new_price - alert.old_price) / alert.old_price) * 100
    : null;

  return (
    <div
      className={`p-4 rounded-lg border ${
        alert.is_read ? 'bg-white border-gray-200' : 'bg-blue-50 border-blue-200'
      }`}
    >
      <div className="flex gap-4">
        {getAlertIcon(alert.alert_type)}

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="font-medium text-gray-900 truncate">
                {alert.product.title || 'Unknown Product'}
              </h3>
              <p className="text-sm text-gray-600">{getAlertMessage()}</p>
              {priceChange !== null && (
                <p className={`text-sm font-medium ${priceChange < 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {priceChange < 0 ? '' : '+'}{priceChange.toFixed(1)}%
                </p>
              )}
            </div>
            <span className="text-xs text-gray-500">
              {formatDistanceToNow(new Date(alert.created_at), { addSuffix: true })}
            </span>
          </div>

          <div className="mt-3 flex gap-2">
            <a
              href={alert.product.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary-600 hover:text-primary-700"
            >
              View Product
            </a>
            {!alert.is_read && onMarkRead && (
              <button
                onClick={() => onMarkRead(alert.id)}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Mark as read
              </button>
            )}
            {onDelete && (
              <button
                onClick={() => onDelete(alert.id)}
                className="text-sm text-red-500 hover:text-red-700"
              >
                Delete
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
