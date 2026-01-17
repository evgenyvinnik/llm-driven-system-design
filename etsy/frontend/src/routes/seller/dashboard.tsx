import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import api from '../../services/api';
import type { Order, Product } from '../../types';

interface ShopStats {
  sales_count: number;
  rating: number;
  review_count: number;
  productCount: number;
  pending_orders: string;
  shipped_orders: string;
  delivered_orders: string;
  total_revenue: string;
  totalViews: number;
  totalFavorites: number;
}

export const Route = createFileRoute('/seller/dashboard')({
  component: SellerDashboard,
});

function SellerDashboard() {
  const { user, isAuthenticated } = useAuthStore();
  const [stats, setStats] = useState<ShopStats | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'orders' | 'products'>('overview');

  const shop = user?.shops?.[0];

  useEffect(() => {
    async function fetchData() {
      if (!shop) return;

      try {
        const [statsRes, ordersRes, productsRes] = await Promise.all([
          api.get<{ stats: ShopStats }>(`/shops/${shop.id}/stats`),
          api.get<{ orders: Order[] }>(`/shops/${shop.id}/orders?limit=10`),
          api.get<{ products: Product[] }>(`/shops/${shop.id}/products`),
        ]);

        setStats(statsRes.stats);
        setOrders(ordersRes.orders);
        setProducts(productsRes.products);
      } catch (error) {
        console.error('Error fetching dashboard data:', error);
      } finally {
        setIsLoading(false);
      }
    }

    if (shop) {
      fetchData();
    } else {
      setIsLoading(false);
    }
  }, [shop]);

  if (!isAuthenticated) {
    window.location.href = '/login';
    return null;
  }

  if (!shop) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">You don't have a shop yet</h1>
        <p className="text-gray-600 mb-6">Create a shop to start selling your items</p>
        <Link to="/seller/create-shop" className="btn btn-primary">
          Open Your Shop
        </Link>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-96">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  const updateOrderStatus = async (orderId: number, status: string, trackingNumber?: string) => {
    try {
      await api.put(`/orders/${orderId}/status`, { status, trackingNumber });
      setOrders(orders.map((o) => (o.id === orderId ? { ...o, status: status as Order['status'] } : o)));
    } catch (error) {
      console.error('Error updating order:', error);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold text-gray-900">{shop.name}</h1>
          <Link to={`/shop/${shop.slug}`} className="text-primary-600 hover:text-primary-700 text-sm">
            View public shop page
          </Link>
        </div>
        <Link to="/seller/products/new" className="btn btn-primary">
          Add New Product
        </Link>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 mb-8">
        <button
          onClick={() => setActiveTab('overview')}
          className={`px-6 py-3 text-sm font-medium border-b-2 ${
            activeTab === 'overview'
              ? 'border-primary-600 text-primary-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Overview
        </button>
        <button
          onClick={() => setActiveTab('orders')}
          className={`px-6 py-3 text-sm font-medium border-b-2 ${
            activeTab === 'orders'
              ? 'border-primary-600 text-primary-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Orders ({parseInt(stats?.pending_orders || '0')})
        </button>
        <button
          onClick={() => setActiveTab('products')}
          className={`px-6 py-3 text-sm font-medium border-b-2 ${
            activeTab === 'products'
              ? 'border-primary-600 text-primary-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Products ({stats?.productCount || 0})
        </button>
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && stats && (
        <div className="space-y-8">
          {/* Stats Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div className="card p-6">
              <p className="text-sm text-gray-600">Total Sales</p>
              <p className="text-3xl font-bold text-gray-900">{stats.sales_count}</p>
            </div>
            <div className="card p-6">
              <p className="text-sm text-gray-600">Revenue</p>
              <p className="text-3xl font-bold text-gray-900">
                ${parseFloat(stats.total_revenue).toFixed(2)}
              </p>
            </div>
            <div className="card p-6">
              <p className="text-sm text-gray-600">Rating</p>
              <p className="text-3xl font-bold text-gray-900">
                {stats.rating > 0 ? stats.rating : 'N/A'}
              </p>
              <p className="text-xs text-gray-500">{stats.review_count} reviews</p>
            </div>
            <div className="card p-6">
              <p className="text-sm text-gray-600">Active Listings</p>
              <p className="text-3xl font-bold text-gray-900">{stats.productCount}</p>
            </div>
          </div>

          {/* Quick Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div className="card p-4">
              <p className="text-sm text-gray-600">Pending Orders</p>
              <p className="text-xl font-semibold text-yellow-600">{stats.pending_orders}</p>
            </div>
            <div className="card p-4">
              <p className="text-sm text-gray-600">Shipped Orders</p>
              <p className="text-xl font-semibold text-blue-600">{stats.shipped_orders}</p>
            </div>
            <div className="card p-4">
              <p className="text-sm text-gray-600">Total Views</p>
              <p className="text-xl font-semibold text-gray-900">{stats.totalViews}</p>
            </div>
            <div className="card p-4">
              <p className="text-sm text-gray-600">Favorites</p>
              <p className="text-xl font-semibold text-gray-900">{stats.totalFavorites}</p>
            </div>
          </div>

          {/* Recent Orders */}
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Orders</h2>
            {orders.length === 0 ? (
              <p className="text-gray-600">No orders yet</p>
            ) : (
              <div className="card overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Order
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Customer
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Total
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {orders.slice(0, 5).map((order) => (
                      <tr key={order.id}>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                          #{order.order_number}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {(order as Order & { buyer_email?: string }).buyer_email}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          ${order.total.toFixed(2)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          <span
                            className={`px-2 py-1 rounded-full text-xs font-medium ${
                              order.status === 'pending'
                                ? 'bg-yellow-100 text-yellow-800'
                                : order.status === 'shipped'
                                  ? 'bg-blue-100 text-blue-800'
                                  : 'bg-green-100 text-green-800'
                            }`}
                          >
                            {order.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Orders Tab */}
      {activeTab === 'orders' && (
        <div className="space-y-4">
          {orders.length === 0 ? (
            <p className="text-gray-600 text-center py-12">No orders yet</p>
          ) : (
            orders.map((order) => (
              <div key={order.id} className="card p-6">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <p className="font-semibold text-gray-900">Order #{order.order_number}</p>
                    <p className="text-sm text-gray-600">
                      {new Date(order.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={order.status}
                      onChange={(e) => updateOrderStatus(order.id, e.target.value)}
                      className="input text-sm"
                    >
                      <option value="pending">Pending</option>
                      <option value="processing">Processing</option>
                      <option value="shipped">Shipped</option>
                      <option value="delivered">Delivered</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </div>
                </div>

                {order.items && (
                  <div className="border-t border-gray-100 pt-4">
                    {order.items.map((item) => (
                      <div key={item.id} className="flex items-center gap-4 py-2">
                        <img
                          src={item.image_url || 'https://via.placeholder.com/60x60'}
                          alt={item.title}
                          className="w-12 h-12 object-cover rounded"
                        />
                        <div className="flex-1">
                          <p className="text-sm font-medium">{item.title}</p>
                          <p className="text-xs text-gray-500">
                            Qty: {item.quantity} x ${item.price.toFixed(2)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="border-t border-gray-100 mt-4 pt-4 flex justify-between">
                  <p className="text-sm text-gray-600">
                    Ship to: {JSON.stringify(order.shipping_address)}
                  </p>
                  <p className="font-semibold">${order.total.toFixed(2)}</p>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Products Tab */}
      {activeTab === 'products' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Link to="/seller/products/new" className="btn btn-primary">
              Add Product
            </Link>
          </div>

          {products.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-600 mb-4">No products yet</p>
              <Link to="/seller/products/new" className="btn btn-primary">
                Add Your First Product
              </Link>
            </div>
          ) : (
            <div className="card overflow-hidden">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Product
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Price
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Stock
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Views
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {products.map((product) => (
                    <tr key={product.id}>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <img
                            src={product.images?.[0] || 'https://via.placeholder.com/50x50'}
                            alt={product.title}
                            className="w-12 h-12 object-cover rounded"
                          />
                          <div>
                            <p className="font-medium text-gray-900">{product.title}</p>
                            <p className="text-xs text-gray-500">{product.category_name}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">
                        ${product.price.toFixed(2)}
                      </td>
                      <td className="px-6 py-4 text-sm">
                        <span
                          className={product.quantity > 0 ? 'text-green-600' : 'text-red-600'}
                        >
                          {product.quantity}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-500">{product.view_count}</td>
                      <td className="px-6 py-4 text-sm">
                        <Link
                          to={`/seller/products/${product.id}/edit`}
                          className="text-primary-600 hover:text-primary-700"
                        >
                          Edit
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
