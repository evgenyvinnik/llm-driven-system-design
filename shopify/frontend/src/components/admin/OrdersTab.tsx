import { useEffect, useState } from 'react';
import { ordersApi } from '../../services/api';
import { Order } from '../../types';
import { ContentLoadingSpinner } from '../common';

/**
 * Props for OrdersTab component.
 */
interface OrdersTabProps {
  /** Store ID to load orders for */
  storeId: number;
}

/**
 * Orders tab component.
 * Displays order list with fulfillment status management.
 *
 * @param props - Orders tab configuration
 * @returns Orders management interface
 */
export function OrdersTab({ storeId }: OrdersTabProps) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadOrders = async () => {
      try {
        const { orders } = await ordersApi.list(storeId);
        setOrders(orders);
      } catch (error) {
        console.error('Failed to load orders:', error);
      } finally {
        setLoading(false);
      }
    };
    loadOrders();
  }, [storeId]);

  /**
   * Updates the fulfillment status of an order.
   */
  const updateOrderStatus = async (orderId: number, fulfillment_status: string) => {
    try {
      await ordersApi.update(storeId, orderId, { fulfillment_status } as Partial<Order>);
      setOrders(orders.map(o =>
        o.id === orderId
          ? { ...o, fulfillment_status: fulfillment_status as Order['fulfillment_status'] }
          : o
      ));
    } catch (error) {
      console.error('Failed to update order:', error);
    }
  };

  if (loading) {
    return <ContentLoadingSpinner />;
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-medium text-gray-900">{orders.length} orders</h2>

      {orders.length === 0 ? (
        <EmptyOrdersState />
      ) : (
        <OrdersTable orders={orders} onUpdateStatus={updateOrderStatus} />
      )}
    </div>
  );
}

/**
 * Empty state when no orders exist.
 */
function EmptyOrdersState() {
  return (
    <div className="bg-white rounded-xl shadow-sm p-12 text-center">
      <p className="text-gray-500">No orders yet. Orders will appear here when customers make purchases.</p>
    </div>
  );
}

/**
 * Orders table component.
 */
interface OrdersTableProps {
  orders: Order[];
  onUpdateStatus: (orderId: number, status: string) => void;
}

function OrdersTable({ orders, onUpdateStatus }: OrdersTableProps) {
  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden">
      <table className="w-full">
        <thead className="bg-gray-50">
          <tr>
            <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">Order</th>
            <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">Customer</th>
            <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">Total</th>
            <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">Payment</th>
            <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">Fulfillment</th>
            <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">Date</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {orders.map((order) => (
            <OrderRow key={order.id} order={order} onUpdateStatus={onUpdateStatus} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Individual order row component.
 */
interface OrderRowProps {
  order: Order;
  onUpdateStatus: (orderId: number, status: string) => void;
}

function OrderRow({ order, onUpdateStatus }: OrderRowProps) {
  return (
    <tr className="hover:bg-gray-50">
      <td className="px-6 py-4 font-medium text-gray-900">{order.order_number}</td>
      <td className="px-6 py-4 text-gray-600">{order.customer_email}</td>
      <td className="px-6 py-4 font-medium">${order.total}</td>
      <td className="px-6 py-4">
        <PaymentStatusBadge status={order.payment_status} />
      </td>
      <td className="px-6 py-4">
        <FulfillmentSelect
          value={order.fulfillment_status}
          onChange={(status) => onUpdateStatus(order.id, status)}
        />
      </td>
      <td className="px-6 py-4 text-gray-500 text-sm">
        {new Date(order.created_at).toLocaleDateString()}
      </td>
    </tr>
  );
}

/**
 * Payment status badge component.
 */
interface PaymentStatusBadgeProps {
  status: Order['payment_status'];
}

function PaymentStatusBadge({ status }: PaymentStatusBadgeProps) {
  const colorClass =
    status === 'paid' ? 'bg-green-100 text-green-700' :
    status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
    'bg-red-100 text-red-700';

  return (
    <span className={`text-xs px-2 py-1 rounded-full ${colorClass}`}>
      {status}
    </span>
  );
}

/**
 * Fulfillment status select component.
 */
interface FulfillmentSelectProps {
  value: Order['fulfillment_status'];
  onChange: (status: string) => void;
}

function FulfillmentSelect({ value, onChange }: FulfillmentSelectProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-sm border border-gray-300 rounded px-2 py-1"
    >
      <option value="unfulfilled">Unfulfilled</option>
      <option value="partial">Partial</option>
      <option value="fulfilled">Fulfilled</option>
    </select>
  );
}
