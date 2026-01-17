import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import { StatusBadge } from '@/components/StatusBadge';
import { PageLoading } from '@/components/LoadingSpinner';
import type { DashboardStats, Order } from '@/types';

export const Route = createFileRoute('/admin')({
  component: AdminDashboard,
});

function AdminDashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recentOrders, setRecentOrders] = useState<Order[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'orders' | 'drivers' | 'merchants'>('overview');

  const { user } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (!user || user.role !== 'admin') {
      navigate({ to: '/login' });
      return;
    }

    loadDashboardData();
  }, [user]);

  const loadDashboardData = async () => {
    setIsLoading(true);
    try {
      const [statsData, ordersData] = await Promise.all([
        api.getAdminStats(),
        api.getAdminOrders(20),
      ]);
      setStats(statsData as DashboardStats);
      setRecentOrders(ordersData as Order[]);
    } catch (error) {
      console.error('Failed to load dashboard data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return <PageLoading />;
  }

  if (!stats) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Failed to load dashboard</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Admin Dashboard</h1>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <StatCard
          title="Orders Today"
          value={stats.orders.today}
          subtitle={`${stats.orders.total} total`}
          icon="📦"
        />
        <StatCard
          title="Active Orders"
          value={stats.orders.in_progress}
          subtitle={`${stats.orders.pending} pending`}
          icon="🚚"
        />
        <StatCard
          title="Drivers Online"
          value={stats.drivers.online}
          subtitle={`${stats.drivers.busy} busy / ${stats.drivers.total} total`}
          icon="🛵"
        />
        <StatCard
          title="Open Merchants"
          value={stats.merchants.open}
          subtitle={`${stats.merchants.total} total`}
          icon="🏪"
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-4 border-b border-gray-200 mb-6">
        {(['overview', 'orders', 'drivers', 'merchants'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 font-medium capitalize ${
              activeTab === tab
                ? 'text-primary-600 border-b-2 border-primary-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <OverviewTab stats={stats} recentOrders={recentOrders} />
      )}
      {activeTab === 'orders' && <OrdersTab />}
      {activeTab === 'drivers' && <DriversTab />}
      {activeTab === 'merchants' && <MerchantsTab />}
    </div>
  );
}

function StatCard({
  title,
  value,
  subtitle,
  icon,
}: {
  title: string;
  value: number;
  subtitle: string;
  icon: string;
}) {
  return (
    <div className="card p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-500">{title}</p>
          <p className="text-3xl font-bold text-gray-900">{value}</p>
          <p className="text-sm text-gray-400 mt-1">{subtitle}</p>
        </div>
        <span className="text-4xl">{icon}</span>
      </div>
    </div>
  );
}

function OverviewTab({
  stats,
  recentOrders,
}: {
  stats: DashboardStats;
  recentOrders: Order[];
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Order Status Breakdown */}
      <div className="card p-6">
        <h3 className="font-semibold text-gray-900 mb-4">Order Status</h3>
        <div className="space-y-3">
          <StatusRow label="Pending" value={stats.orders.pending} color="bg-yellow-500" />
          <StatusRow label="In Progress" value={stats.orders.in_progress} color="bg-blue-500" />
          <StatusRow label="Completed" value={stats.orders.completed} color="bg-green-500" />
          <StatusRow label="Cancelled" value={stats.orders.cancelled} color="bg-red-500" />
        </div>
      </div>

      {/* Recent Orders */}
      <div className="card p-6">
        <h3 className="font-semibold text-gray-900 mb-4">Recent Orders</h3>
        <div className="space-y-3 max-h-80 overflow-y-auto">
          {recentOrders.slice(0, 10).map((order) => (
            <div
              key={order.id}
              className="flex justify-between items-center py-2 border-b border-gray-100"
            >
              <div>
                <p className="text-sm font-medium">#{order.id.slice(0, 8)}</p>
                <p className="text-xs text-gray-500">
                  {new Date(order.created_at).toLocaleString()}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-medium">${order.total.toFixed(2)}</span>
                <StatusBadge status={order.status} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusRow({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className={`w-3 h-3 rounded-full ${color}`} />
      <span className="flex-1 text-gray-600">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function OrdersTab() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadOrders();
  }, []);

  const loadOrders = async () => {
    setIsLoading(true);
    try {
      const data = await api.getAdminOrders(100);
      setOrders(data as Order[]);
    } catch (error) {
      console.error('Failed to load orders:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) return <PageLoading />;

  return (
    <div className="card overflow-hidden">
      <table className="w-full">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Order ID</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Date</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Status</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Address</th>
            <th className="px-4 py-3 text-right text-sm font-medium text-gray-500">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {orders.map((order) => (
            <tr key={order.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 text-sm font-mono">{order.id.slice(0, 8)}</td>
              <td className="px-4 py-3 text-sm text-gray-500">
                {new Date(order.created_at).toLocaleString()}
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={order.status} />
              </td>
              <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate">
                {order.delivery_address}
              </td>
              <td className="px-4 py-3 text-sm font-medium text-right">
                ${order.total.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DriversTab() {
  const [drivers, setDrivers] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadDrivers();
  }, []);

  const loadDrivers = async () => {
    setIsLoading(true);
    try {
      const data = await api.getAdminDrivers();
      setDrivers(data as any[]);
    } catch (error) {
      console.error('Failed to load drivers:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) return <PageLoading />;

  return (
    <div className="card overflow-hidden">
      <table className="w-full">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Name</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Email</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Vehicle</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Status</th>
            <th className="px-4 py-3 text-center text-sm font-medium text-gray-500">Rating</th>
            <th className="px-4 py-3 text-center text-sm font-medium text-gray-500">Deliveries</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {drivers.map((driver) => (
            <tr key={driver.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 text-sm font-medium">{driver.name}</td>
              <td className="px-4 py-3 text-sm text-gray-500">{driver.email}</td>
              <td className="px-4 py-3 text-sm capitalize">{driver.vehicle_type}</td>
              <td className="px-4 py-3">
                <span
                  className={`px-2 py-1 rounded-full text-xs font-medium ${
                    driver.status === 'available'
                      ? 'bg-green-100 text-green-800'
                      : driver.status === 'busy'
                      ? 'bg-yellow-100 text-yellow-800'
                      : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {driver.status}
                </span>
              </td>
              <td className="px-4 py-3 text-sm text-center">⭐ {driver.rating.toFixed(2)}</td>
              <td className="px-4 py-3 text-sm text-center">{driver.total_deliveries}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MerchantsTab() {
  const [merchants, setMerchants] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadMerchants();
  }, []);

  const loadMerchants = async () => {
    setIsLoading(true);
    try {
      const data = await api.getAdminMerchants();
      setMerchants(data as any[]);
    } catch (error) {
      console.error('Failed to load merchants:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) return <PageLoading />;

  return (
    <div className="card overflow-hidden">
      <table className="w-full">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Name</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Category</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Address</th>
            <th className="px-4 py-3 text-center text-sm font-medium text-gray-500">Status</th>
            <th className="px-4 py-3 text-center text-sm font-medium text-gray-500">Rating</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {merchants.map((merchant) => (
            <tr key={merchant.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 text-sm font-medium">{merchant.name}</td>
              <td className="px-4 py-3 text-sm capitalize">{merchant.category}</td>
              <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">
                {merchant.address}
              </td>
              <td className="px-4 py-3 text-center">
                <span
                  className={`px-2 py-1 rounded-full text-xs font-medium ${
                    merchant.is_open
                      ? 'bg-green-100 text-green-800'
                      : 'bg-red-100 text-red-800'
                  }`}
                >
                  {merchant.is_open ? 'Open' : 'Closed'}
                </span>
              </td>
              <td className="px-4 py-3 text-sm text-center">⭐ {merchant.rating.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
