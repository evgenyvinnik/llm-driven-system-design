import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '@/services/api';
import { useCartStore } from '@/stores/cartStore';
import { MenuItemCard } from '@/components/MenuItemCard';
import { PageLoading } from '@/components/LoadingSpinner';
import { Link } from '@tanstack/react-router';
import type { Merchant, MenuItem } from '@/types';

export const Route = createFileRoute('/merchants/$merchantId')({
  component: MerchantPage,
});

function MerchantPage() {
  const { merchantId } = Route.useParams();
  const [merchant, setMerchant] = useState<Merchant | null>(null);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const { setMerchant: setCartMerchant, items, getSubtotal, getItemCount } = useCartStore();

  useEffect(() => {
    loadMerchant();
  }, [merchantId]);

  const loadMerchant = async () => {
    setIsLoading(true);
    try {
      const data = (await api.getMerchantMenu(merchantId)) as {
        merchant: Merchant;
        menu: MenuItem[];
      };
      setMerchant(data.merchant);
      setMenuItems(data.menu);
      setCartMerchant(data.merchant);
    } catch (error) {
      console.error('Failed to load merchant:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return <PageLoading />;
  }

  if (!merchant) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 text-lg">Merchant not found</p>
      </div>
    );
  }

  // Group items by category
  const itemsByCategory = menuItems.reduce(
    (acc, item) => {
      const category = item.category || 'Other';
      if (!acc[category]) {
        acc[category] = [];
      }
      acc[category].push(item);
      return acc;
    },
    {} as Record<string, MenuItem[]>
  );

  const itemCount = getItemCount();
  const subtotal = getSubtotal();

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Merchant Header */}
      <div className="card p-6 mb-8">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">{merchant.name}</h1>
            <p className="text-gray-600 mb-2">{merchant.category}</p>
            {merchant.description && (
              <p className="text-gray-500 mb-4">{merchant.description}</p>
            )}
            <div className="flex items-center gap-4 text-sm text-gray-500">
              <span>⭐ {merchant.rating.toFixed(1)}</span>
              <span>🕐 {merchant.avg_prep_time_minutes} min prep</span>
              <span>📍 {merchant.address}</span>
            </div>
          </div>
          <div className="text-right">
            {merchant.is_open ? (
              <span className="text-green-600 font-medium">Open</span>
            ) : (
              <span className="text-red-600 font-medium">Closed</span>
            )}
            <p className="text-sm text-gray-500 mt-1">
              {merchant.opens_at} - {merchant.closes_at}
            </p>
          </div>
        </div>
      </div>

      {/* Menu */}
      <div className="space-y-8">
        {Object.entries(itemsByCategory).map(([category, categoryItems]) => (
          <div key={category}>
            <h2 className="text-lg font-semibold text-gray-900 mb-4 capitalize">{category}</h2>
            <div className="space-y-3">
              {categoryItems.map((item) => (
                <MenuItemCard key={item.id} item={item} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Cart Summary */}
      {itemCount > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-4 shadow-lg">
          <div className="max-w-4xl mx-auto flex justify-between items-center">
            <div>
              <span className="font-semibold">{itemCount} items</span>
              <span className="text-gray-500 ml-2">${subtotal.toFixed(2)}</span>
            </div>
            <Link to="/cart" className="btn-primary">
              View Cart
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
