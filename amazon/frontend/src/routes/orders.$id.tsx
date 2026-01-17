import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { api } from '../services/api';
import type { Order } from '../types';

export const Route = createFileRoute('/orders/$id')({
  component: OrderDetailPage,
});

function OrderDetailPage() {
  const { id } = Route.useParams();
  const { user } = useAuthStore();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (user) {
      fetchOrder();
    }
  }, [user, id]);

  const fetchOrder = async () => {
    try {
      const { order } = await api.getOrder(parseInt(id));
      setOrder(order);
    } catch (error) {
      console.error('Failed to fetch order:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!confirm('Are you sure you want to cancel this order?')) return;

    setCancelling(true);
    try {
      const { order: updatedOrder } = await api.cancelOrder(parseInt(id));
      setOrder(updatedOrder);
    } catch (error) {
      alert((error as Error).message);
    } finally {
      setCancelling(false);
    }
  };

  if (!user) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8 text-center">
        <p className="text-gray-500 mb-6">Please sign in to view order details</p>
        <Link
          to="/login"
          className="inline-block px-8 py-3 bg-amber-400 hover:bg-amber-500 text-black font-bold rounded-full"
        >
          Sign In
        </Link>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-300 rounded w-1/3 mb-6" />
          <div className="h-64 bg-gray-300 rounded-lg" />
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8 text-center">
        <h1 className="text-2xl font-bold mb-4">Order Not Found</h1>
        <Link to="/orders" className="text-blue-600 hover:underline">
          Back to Orders
        </Link>
      </div>
    );
  }

  const getStatusColor = (status: Order['status']) => {
    switch (status) {
      case 'delivered':
        return 'bg-green-100 text-green-800';
      case 'shipped':
        return 'bg-blue-100 text-blue-800';
      case 'processing':
      case 'confirmed':
        return 'bg-yellow-100 text-yellow-800';
      case 'cancelled':
      case 'refunded':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const canCancel = ['pending', 'confirmed'].includes(order.status);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link to="/orders" className="text-blue-600 hover:underline text-sm">
            Back to Orders
          </Link>
          <h1 className="text-2xl font-bold mt-2">Order #{order.id}</h1>
        </div>
        <span className={`px-4 py-2 rounded-full font-medium ${getStatusColor(order.status)}`}>
          {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Order Items */}
        <div className="lg:col-span-2">
          <div className="bg-white rounded-lg shadow">
            <div className="p-4 border-b">
              <h2 className="font-bold">Order Items</h2>
            </div>
            {order.items?.map((item) => (
              <div key={item.id} className="p-4 border-b flex gap-4">
                <Link
                  to="/product/$id"
                  params={{ id: item.product_id?.toString() || '' }}
                  className="w-20 h-20 bg-gray-100 rounded flex-shrink-0 overflow-hidden"
                >
                  {item.images?.[0] ? (
                    <img src={item.images[0]} alt={item.product_title} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-400 text-xs">
                      No Image
                    </div>
                  )}
                </Link>
                <div className="flex-1">
                  <Link
                    to="/product/$id"
                    params={{ id: item.product_id?.toString() || '' }}
                    className="font-medium hover:text-blue-600"
                  >
                    {item.product_title}
                  </Link>
                  <p className="text-sm text-gray-500">Qty: {item.quantity}</p>
                </div>
                <div className="text-right">
                  <p className="font-bold">${item.price}</p>
                  {item.quantity > 1 && (
                    <p className="text-sm text-gray-500">
                      ${(parseFloat(item.price) * item.quantity).toFixed(2)} total
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Order Summary */}
        <div className="space-y-6">
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="font-bold mb-4">Order Summary</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>${order.subtotal}</span>
              </div>
              <div className="flex justify-between">
                <span>Shipping</span>
                <span>{parseFloat(order.shipping_cost) === 0 ? 'FREE' : `$${order.shipping_cost}`}</span>
              </div>
              <div className="flex justify-between">
                <span>Tax</span>
                <span>${order.tax}</span>
              </div>
              <div className="border-t pt-2 mt-2 flex justify-between font-bold">
                <span>Total</span>
                <span>${order.total}</span>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="font-bold mb-4">Shipping Address</h2>
            <div className="text-sm text-gray-700">
              <p>{order.shipping_address.street}</p>
              <p>
                {order.shipping_address.city}, {order.shipping_address.state} {order.shipping_address.zip}
              </p>
              <p>{order.shipping_address.country}</p>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="font-bold mb-4">Order Details</h2>
            <div className="text-sm space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-500">Order Date</span>
                <span>
                  {new Date(order.created_at).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Payment Status</span>
                <span className="capitalize">{order.payment_status}</span>
              </div>
            </div>
          </div>

          {canCancel && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="w-full py-2 border border-red-600 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50"
            >
              {cancelling ? 'Cancelling...' : 'Cancel Order'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
