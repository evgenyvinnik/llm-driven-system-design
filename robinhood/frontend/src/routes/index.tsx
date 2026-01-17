import { createFileRoute, redirect } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useQuoteStore } from '../stores/quoteStore';
import { PortfolioSummary, HoldingsList } from '../components/Portfolio';
import { usePortfolioStore } from '../stores/portfolioStore';

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    const { isAuthenticated } = useAuthStore.getState();
    if (!isAuthenticated) {
      throw redirect({ to: '/login' });
    }
  },
  component: HomePage,
});

function HomePage() {
  const { initializeConnection } = useQuoteStore();
  const { fetchWatchlists } = usePortfolioStore();

  useEffect(() => {
    initializeConnection();
    fetchWatchlists();
  }, [initializeConnection, fetchWatchlists]);

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <PortfolioSummary />
          <HoldingsList />
        </div>

        <div className="space-y-6">
          <RecentActivity />
        </div>
      </div>
    </div>
  );
}

function RecentActivity() {
  const { orders, fetchOrders } = usePortfolioStore();

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const recentOrders = orders.slice(0, 5);

  return (
    <div className="bg-robinhood-gray-800 rounded-lg p-6">
      <h3 className="text-lg font-semibold text-white mb-4">Recent Activity</h3>
      {recentOrders.length === 0 ? (
        <p className="text-robinhood-gray-400">No recent orders</p>
      ) : (
        <div className="space-y-3">
          {recentOrders.map((order) => (
            <div
              key={order.id}
              className="flex items-center justify-between p-3 bg-robinhood-gray-700 rounded-lg"
            >
              <div>
                <p className="text-white font-medium">
                  <span
                    className={
                      order.side === 'buy'
                        ? 'text-robinhood-green'
                        : 'text-robinhood-red'
                    }
                  >
                    {order.side.toUpperCase()}
                  </span>{' '}
                  {order.symbol}
                </p>
                <p className="text-sm text-robinhood-gray-400">
                  {order.quantity} shares @ ${order.avg_fill_price?.toFixed(2) || '--'}
                </p>
              </div>
              <div className="text-right">
                <p
                  className={`text-sm ${
                    order.status === 'filled'
                      ? 'text-robinhood-green'
                      : order.status === 'cancelled'
                      ? 'text-robinhood-red'
                      : 'text-robinhood-gray-400'
                  }`}
                >
                  {order.status.toUpperCase()}
                </p>
                <p className="text-xs text-robinhood-gray-400">
                  {new Date(order.created_at).toLocaleDateString()}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
