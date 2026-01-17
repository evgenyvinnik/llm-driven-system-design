import { Analytics, Store } from '../../types';

/**
 * Props for DashboardTab component.
 */
interface DashboardTabProps {
  /** Analytics data for the store */
  analytics: Analytics | null;
  /** Current store */
  store: Store;
}

/**
 * Dashboard tab component.
 * Displays store analytics including revenue, orders, and recent activity.
 *
 * @param props - Dashboard configuration
 * @returns Dashboard layout with stats, quick info, and recent orders
 */
export function DashboardTab({ analytics, store }: DashboardTabProps) {
  if (!analytics) return null;

  const stats = [
    { label: 'Total Revenue', value: `$${analytics.orders.revenue.toFixed(2)}`, icon: '💰' },
    { label: 'Total Orders', value: analytics.orders.total, icon: '📦' },
    { label: 'Products', value: analytics.products.total, icon: '🏷️' },
    { label: 'Customers', value: analytics.customers.total, icon: '👥' },
  ];

  return (
    <div className="space-y-6">
      <StatsGrid stats={stats} />
      <QuickStats pendingOrders={analytics.orders.unfulfilled} storeStatus={store.status} />
      <RecentOrdersTable orders={analytics.recentOrders} />
    </div>
  );
}

/**
 * Stats grid component for displaying key metrics.
 */
interface StatItem {
  label: string;
  value: string | number;
  icon: string;
}

interface StatsGridProps {
  stats: StatItem[];
}

function StatsGrid({ stats }: StatsGridProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      {stats.map((stat) => (
        <div key={stat.label} className="bg-white rounded-xl shadow-sm p-6">
          <div className="flex items-center gap-4">
            <span className="text-3xl">{stat.icon}</span>
            <div>
              <p className="text-sm text-gray-500">{stat.label}</p>
              <p className="text-2xl font-bold text-gray-900">{stat.value}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Quick stats section for pending orders and store status.
 */
interface QuickStatsProps {
  pendingOrders: number;
  storeStatus: Store['status'];
}

function QuickStats({ pendingOrders, storeStatus }: QuickStatsProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="bg-white rounded-xl shadow-sm p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Pending Orders</h3>
        <div className="text-4xl font-bold text-orange-500">{pendingOrders}</div>
        <p className="text-gray-500 text-sm mt-1">Orders awaiting fulfillment</p>
      </div>

      <div className="bg-white rounded-xl shadow-sm p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Store Status</h3>
        <div className="flex items-center gap-2">
          <span className={`w-3 h-3 rounded-full ${storeStatus === 'active' ? 'bg-green-500' : 'bg-gray-400'}`}></span>
          <span className="text-lg font-medium capitalize">{storeStatus}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Recent orders table component.
 */
interface RecentOrdersTableProps {
  orders: Analytics['recentOrders'];
}

function RecentOrdersTable({ orders }: RecentOrdersTableProps) {
  return (
    <div className="bg-white rounded-xl shadow-sm p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Recent Orders</h3>
      {orders.length === 0 ? (
        <p className="text-gray-500">No orders yet</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2 text-sm font-medium text-gray-500">Order</th>
                <th className="text-left py-2 text-sm font-medium text-gray-500">Customer</th>
                <th className="text-left py-2 text-sm font-medium text-gray-500">Total</th>
                <th className="text-left py-2 text-sm font-medium text-gray-500">Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id} className="border-b last:border-0">
                  <td className="py-3 text-sm font-medium">{order.order_number}</td>
                  <td className="py-3 text-sm text-gray-600">{order.customer_email}</td>
                  <td className="py-3 text-sm">${order.total}</td>
                  <td className="py-3">
                    <PaymentStatusBadge status={order.payment_status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Payment status badge component.
 */
interface PaymentStatusBadgeProps {
  status: string;
}

function PaymentStatusBadge({ status }: PaymentStatusBadgeProps) {
  const colorClass = status === 'paid' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700';

  return (
    <span className={`text-xs px-2 py-1 rounded-full ${colorClass}`}>
      {status}
    </span>
  );
}
