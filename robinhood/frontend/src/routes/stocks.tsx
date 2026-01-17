/**
 * Stocks browse page route (/stocks).
 * Displays searchable list of all available stocks.
 * Requires authentication.
 */

import { createFileRoute, redirect } from '@tanstack/react-router';
import { StockSearch } from '../components/Watchlist';
import { useAuthStore } from '../stores/authStore';

/** Route definition with auth guard */
export const Route = createFileRoute('/stocks')({
  beforeLoad: () => {
    const { isAuthenticated } = useAuthStore.getState();
    if (!isAuthenticated) {
      throw redirect({ to: '/login' });
    }
  },
  component: StocksPage,
});

/**
 * Stocks browse page component.
 * Shows searchable grid of all available stocks.
 */
function StocksPage() {
  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-white mb-6">Stocks</h1>
      <StockSearch />
    </div>
  );
}
