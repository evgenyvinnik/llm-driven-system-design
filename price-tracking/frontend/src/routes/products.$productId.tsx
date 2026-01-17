import { createFileRoute, Navigate, useParams } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useProductStore } from '../stores/productStore';
import { useEffect, useState } from 'react';
import { getDailyPrices } from '../services/products';
import { PriceChart } from '../components/PriceChart';
import { DailyPrice, Product } from '../types';
import { formatDistanceToNow, format } from 'date-fns';

function ProductDetailPage() {
  const { productId } = useParams({ from: '/products/$productId' });
  const { isAuthenticated } = useAuthStore();
  const { products, fetchProducts, updateProduct } = useProductStore();

  const [dailyPrices, setDailyPrices] = useState<DailyPrice[]>([]);
  const [isLoadingChart, setIsLoadingChart] = useState(true);
  const [selectedDays, setSelectedDays] = useState(90);
  const [isEditing, setIsEditing] = useState(false);
  const [targetPrice, setTargetPrice] = useState('');
  const [notifyAnyDrop, setNotifyAnyDrop] = useState(false);

  const product = products.find((p) => p.id === productId);

  useEffect(() => {
    if (isAuthenticated && products.length === 0) {
      fetchProducts();
    }
  }, [isAuthenticated, products.length, fetchProducts]);

  useEffect(() => {
    if (product) {
      setTargetPrice(product.target_price?.toString() || '');
      setNotifyAnyDrop(product.notify_any_drop || false);
    }
  }, [product]);

  useEffect(() => {
    if (productId) {
      setIsLoadingChart(true);
      getDailyPrices(productId, selectedDays)
        .then(setDailyPrices)
        .finally(() => setIsLoadingChart(false));
    }
  }, [productId, selectedDays]);

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  if (!product) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  const formatPrice = (price: number | null, currency: string = 'USD') => {
    if (price === null) return 'N/A';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(price);
  };

  const handleSaveSettings = async () => {
    await updateProduct(productId, {
      target_price: targetPrice ? parseFloat(targetPrice) : null,
      notify_any_drop: notifyAnyDrop,
    });
    setIsEditing(false);
  };

  const lowestPrice = dailyPrices.length > 0
    ? Math.min(...dailyPrices.map((d) => d.min_price))
    : null;

  const highestPrice = dailyPrices.length > 0
    ? Math.max(...dailyPrices.map((d) => d.max_price))
    : null;

  const averagePrice = dailyPrices.length > 0
    ? dailyPrices.reduce((sum, d) => sum + d.avg_price, 0) / dailyPrices.length
    : null;

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex gap-6">
          {product.image_url ? (
            <img
              src={product.image_url}
              alt={product.title || 'Product'}
              className="w-32 h-32 object-contain rounded-lg bg-gray-100"
            />
          ) : (
            <div className="w-32 h-32 bg-gray-100 rounded-lg flex items-center justify-center">
              <span className="text-gray-400">No image</span>
            </div>
          )}

          <div className="flex-1">
            <h1 className="text-xl font-bold text-gray-900">{product.title || 'Loading...'}</h1>
            <p className="text-sm text-gray-500">{product.domain}</p>

            <div className="mt-4 flex items-center gap-6">
              <div>
                <p className="text-sm text-gray-500">Current Price</p>
                <p className="text-3xl font-bold text-gray-900">
                  {formatPrice(product.current_price, product.currency)}
                </p>
              </div>

              {lowestPrice !== null && (
                <div>
                  <p className="text-sm text-gray-500">Lowest ({selectedDays}d)</p>
                  <p className="text-lg font-semibold text-green-600">
                    {formatPrice(lowestPrice, product.currency)}
                  </p>
                </div>
              )}

              {highestPrice !== null && (
                <div>
                  <p className="text-sm text-gray-500">Highest ({selectedDays}d)</p>
                  <p className="text-lg font-semibold text-red-600">
                    {formatPrice(highestPrice, product.currency)}
                  </p>
                </div>
              )}

              {averagePrice !== null && (
                <div>
                  <p className="text-sm text-gray-500">Average ({selectedDays}d)</p>
                  <p className="text-lg font-semibold text-gray-700">
                    {formatPrice(averagePrice, product.currency)}
                  </p>
                </div>
              )}
            </div>

            <div className="mt-4 flex gap-3">
              <a
                href={product.url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary"
              >
                Visit Store
              </a>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Price History</h2>
          <div className="flex gap-2">
            {[30, 90, 180, 365].map((days) => (
              <button
                key={days}
                onClick={() => setSelectedDays(days)}
                className={`px-3 py-1 text-sm rounded-lg ${
                  selectedDays === days
                    ? 'bg-primary-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {days}d
              </button>
            ))}
          </div>
        </div>

        {isLoadingChart ? (
          <div className="h-80 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          </div>
        ) : (
          <PriceChart
            data={dailyPrices}
            currency={product.currency}
            targetPrice={product.target_price}
          />
        )}
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Alert Settings</h2>
          {!isEditing && (
            <button
              onClick={() => setIsEditing(true)}
              className="btn btn-secondary text-sm"
            >
              Edit
            </button>
          )}
        </div>

        {isEditing ? (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Target Price
              </label>
              <div className="relative max-w-xs">
                <span className="absolute left-3 top-2 text-gray-500">$</span>
                <input
                  type="number"
                  value={targetPrice}
                  onChange={(e) => setTargetPrice(e.target.value)}
                  placeholder="0.00"
                  step="0.01"
                  min="0"
                  className="input pl-8"
                />
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Get notified when the price drops to or below this amount
              </p>
            </div>

            <label className="flex items-center space-x-2">
              <input
                type="checkbox"
                checked={notifyAnyDrop}
                onChange={(e) => setNotifyAnyDrop(e.target.checked)}
                className="rounded text-primary-600 focus:ring-primary-500"
              />
              <span className="text-sm text-gray-700">Notify me on any price drop</span>
            </label>

            <div className="flex gap-2">
              <button onClick={handleSaveSettings} className="btn btn-primary">
                Save
              </button>
              <button onClick={() => setIsEditing(false)} className="btn btn-secondary">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-gray-700">
              <span className="font-medium">Target Price:</span>{' '}
              {product.target_price ? formatPrice(product.target_price, product.currency) : 'Not set'}
            </p>
            <p className="text-gray-700">
              <span className="font-medium">Notify on any drop:</span>{' '}
              {product.notify_any_drop ? 'Yes' : 'No'}
            </p>
          </div>
        )}
      </div>

      <div className="text-sm text-gray-500">
        <p>
          Last updated:{' '}
          {product.last_scraped
            ? `${formatDistanceToNow(new Date(product.last_scraped), { addSuffix: true })} (${format(new Date(product.last_scraped), 'PPpp')})`
            : 'Never'}
        </p>
        <p>Added: {format(new Date(product.created_at), 'PPpp')}</p>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/products/$productId')({
  component: ProductDetailPage,
});
