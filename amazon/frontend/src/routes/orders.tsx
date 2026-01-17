import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { api } from '../services/api';
import type { Order } from '../types';

export const Route = createFileRoute('/orders')({
  component: OrdersPage,
});

function OrdersPage() {
  const { user } = useAuthStore();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user) {
      fetchOrders();
    }
  }, [user]);

  const fetchOrders = async () => {
    try {
      const { orders } = await api.getOrders();
      setOrders(orders);
    } catch (error) {
      console.error('Failed to fetch orders:', error);
    } finally {
      setLoading(false);
    }
  };

  if (!user) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8 text-center">
        <h1 className="text-2xl font-bold mb-4">Your Orders</h1>
        <p className="text-gray-500 mb-6">Please sign in to view your orders</p>
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
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 bg-gray-300 rounded-lg" />
          ))}
        </div>
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

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Your Orders</h1>

      {orders.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg shadow">
          <p className="text-gray-500 text-lg mb-4">You have no orders yet</p>
          <Link
            to="/"
            className="inline-block px-8 py-3 bg-amber-400 hover:bg-amber-500 text-black font-bold rounded-full"
          >
            Start Shopping
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {orders.map((order) => (
            <Link
              key={order.id}
              to="/orders/$id"
              params={{ id: order.id.toString() }}
              className="block bg-white rounded-lg shadow hover:shadow-lg transition-shadow"
            >
              <div className="p-4 border-b flex justify-between items-center">
                <div>
                  <span className="text-sm text-gray-500">ORDER PLACED</span>
                  <p className="font-medium">
                    {new Date(order.created_at).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </p>
                </div>
                <div>
                  <span className="text-sm text-gray-500">TOTAL</span>
                  <p className="font-medium">${order.total}</p>
                </div>
                <div>
                  <span className="text-sm text-gray-500">ORDER #</span>
                  <p className="font-medium">{order.id}</p>
                </div>
                <span className={`px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(order.status)}`}>
                  {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
                </span>
              </div>

              <div className="p-4">
                {order.items && order.items.length > 0 ? (
                  <div className="flex gap-4">
                    {order.items.slice(0, 4).map((item, i) => (
                      <div key={i} className="w-16 h-16 bg-gray-100 rounded overflow-hidden">
                        {item.images?.[0] && (
                          <img src={item.images[0]} alt="" className="w-full h-full object-cover" />
                        )}
                      </div>
                    ))}
                    {order.items.length > 4 && (
                      <div className="w-16 h-16 bg-gray-100 rounded flex items-center justify-center text-gray-500 text-sm">
                        +{order.items.length - 4} more
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-gray-500 text-sm">View order details</p>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
