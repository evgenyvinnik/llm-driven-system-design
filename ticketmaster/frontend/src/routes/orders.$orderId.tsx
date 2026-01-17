import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { checkoutApi } from '../services/api';
import { useAuthStore } from '../stores/auth.store';
import type { Order } from '../types';

export const Route = createFileRoute('/orders/$orderId')({
  component: OrderDetailPage,
});

function OrderDetailPage() {
  const { orderId } = Route.useParams();
  const { isAuthenticated } = useAuthStore();
  const [orderData, setOrderData] = useState<{
    order: Order;
    seats: { section: string; row: string; seat_number: string; price: number }[];
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;

    const fetchOrder = async () => {
      try {
        const response = await checkoutApi.getOrder(orderId);
        setOrderData(response.data || null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load order');
      } finally {
        setIsLoading(false);
      }
    };

    fetchOrder();
  }, [orderId, isAuthenticated]);

  if (!isAuthenticated) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8 text-center">
        <p className="text-gray-600 mb-4">Please sign in to view your order</p>
        <Link to="/login" className="text-ticketmaster-blue hover:underline">
          Sign In
        </Link>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-ticketmaster-blue"></div>
      </div>
    );
  }

  if (error || !orderData) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8 text-center">
        <p className="text-red-600 mb-4">{error || 'Order not found'}</p>
        <Link to="/orders" className="text-ticketmaster-blue hover:underline">
          Back to orders
        </Link>
      </div>
    );
  }

  const { order, seats } = orderData;

  const getStatusColor = (status: Order['status']) => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 text-green-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'cancelled':
        return 'bg-gray-100 text-gray-800';
      case 'refunded':
        return 'bg-blue-100 text-blue-800';
      case 'payment_failed':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <Link to="/orders" className="text-ticketmaster-blue hover:underline mb-4 inline-block">
        &larr; Back to orders
      </Link>

      {order.status === 'completed' && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
          <div className="flex items-center">
            <svg className="w-6 h-6 text-green-600 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-green-800 font-medium">Order confirmed!</span>
          </div>
          <p className="text-green-700 text-sm mt-1">Your tickets have been purchased successfully.</p>
        </div>
      )}

      <div className="bg-white rounded-lg shadow-lg overflow-hidden">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                {(order as Order & { event_name?: string }).event_name || 'Event'}
              </h1>
              {(order as Order & { artist?: string }).artist && (
                <p className="text-lg text-gray-600">{(order as Order & { artist?: string }).artist}</p>
              )}
            </div>
            <span className={`px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(order.status)}`}>
              {order.status.charAt(0).toUpperCase() + order.status.slice(1).replace('_', ' ')}
            </span>
          </div>

          <div className="mt-4 space-y-2 text-gray-600">
            <div className="flex items-center">
              <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              {(order as Order & { venue_name?: string; venue_city?: string; venue_address?: string }).venue_name},{' '}
              {(order as Order & { venue_city?: string }).venue_city}
            </div>
            {(order as Order & { event_date?: string }).event_date && (
              <div className="flex items-center">
                <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                {new Date((order as Order & { event_date: string }).event_date).toLocaleDateString('en-US', {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}{' '}
                at{' '}
                {new Date((order as Order & { event_date: string }).event_date).toLocaleTimeString('en-US', {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </div>
            )}
          </div>
        </div>

        <div className="p-6 border-b border-gray-200">
          <h2 className="text-lg font-semibold mb-4">Your Tickets ({seats.length})</h2>
          <div className="space-y-3">
            {seats.map((seat, index) => (
              <div
                key={index}
                className="flex items-center justify-between py-3 px-4 bg-gray-50 rounded-lg"
              >
                <div>
                  <span className="font-medium">{seat.section}</span>
                  <span className="mx-2 text-gray-400">|</span>
                  <span>Row {seat.row}, Seat {seat.seat_number}</span>
                </div>
                <span className="font-medium">${seat.price.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="p-6 bg-gray-50">
          <div className="flex items-center justify-between mb-2">
            <span className="text-gray-600">Subtotal</span>
            <span>${parseFloat(String(order.total_amount)).toFixed(2)}</span>
          </div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-gray-600">Service fees</span>
            <span>Included</span>
          </div>
          <div className="flex items-center justify-between pt-4 border-t border-gray-200">
            <span className="text-lg font-semibold">Total</span>
            <span className="text-2xl font-bold">${parseFloat(String(order.total_amount)).toFixed(2)}</span>
          </div>
        </div>

        <div className="p-6 border-t border-gray-200 text-sm text-gray-500">
          <p>Order ID: {order.id}</p>
          <p>Payment ID: {order.payment_id}</p>
          <p>Ordered: {new Date(order.created_at).toLocaleString()}</p>
        </div>
      </div>
    </div>
  );
}
