/**
 * Form component for adding new products to track.
 * Includes URL input, optional target price, and notification preferences.
 * @module components/AddProductForm
 */
import { useState } from 'react';

/** Props for the AddProductForm component */
interface AddProductFormProps {
  /** Callback when form is submitted with valid data */
  onSubmit: (url: string, targetPrice?: number, notifyAnyDrop?: boolean) => Promise<void>;
  /** Whether the form is currently submitting */
  isLoading?: boolean;
}

/**
 * Renders a form for adding new products to track.
 * Validates URL format and handles form submission.
 * Provides advanced options for target price and notifications.
 * @param props - Component props
 */
export function AddProductForm({ onSubmit, isLoading }: AddProductFormProps) {
  const [url, setUrl] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [notifyAnyDrop, setNotifyAnyDrop] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!url.trim()) {
      setError('Please enter a product URL');
      return;
    }

    try {
      new URL(url);
    } catch {
      setError('Please enter a valid URL');
      return;
    }

    try {
      await onSubmit(
        url.trim(),
        targetPrice ? parseFloat(targetPrice) : undefined,
        notifyAnyDrop
      );
      setUrl('');
      setTargetPrice('');
      setNotifyAnyDrop(false);
      setShowAdvanced(false);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to add product';
      setError(errorMessage);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="card">
      <h2 className="text-lg font-semibold mb-4">Track New Product</h2>

      <div className="space-y-4">
        <div>
          <label htmlFor="url" className="block text-sm font-medium text-gray-700 mb-1">
            Product URL
          </label>
          <input
            type="url"
            id="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.amazon.com/product..."
            className="input"
            disabled={isLoading}
          />
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-sm text-primary-600 hover:text-primary-700"
        >
          {showAdvanced ? 'Hide' : 'Show'} advanced options
        </button>

        {showAdvanced && (
          <div className="space-y-4 p-4 bg-gray-50 rounded-lg">
            <div>
              <label htmlFor="targetPrice" className="block text-sm font-medium text-gray-700 mb-1">
                Target Price (optional)
              </label>
              <div className="relative">
                <span className="absolute left-3 top-2 text-gray-500">$</span>
                <input
                  type="number"
                  id="targetPrice"
                  value={targetPrice}
                  onChange={(e) => setTargetPrice(e.target.value)}
                  placeholder="0.00"
                  step="0.01"
                  min="0"
                  className="input pl-8"
                  disabled={isLoading}
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
                disabled={isLoading}
              />
              <span className="text-sm text-gray-700">Notify me on any price drop</span>
            </label>
          </div>
        )}

        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}

        <button
          type="submit"
          disabled={isLoading}
          className="btn btn-primary w-full"
        >
          {isLoading ? 'Adding...' : 'Track Product'}
        </button>
      </div>
    </form>
  );
}
