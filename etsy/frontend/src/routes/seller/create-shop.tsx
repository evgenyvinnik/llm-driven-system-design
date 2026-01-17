import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import api from '../../services/api';
import type { Shop } from '../../types';

export const Route = createFileRoute('/seller/create-shop')({
  component: CreateShopPage,
});

function CreateShopPage() {
  const { isAuthenticated, checkAuth } = useAuthStore();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    location: '',
    returnPolicy: '',
  });

  if (!isAuthenticated) {
    window.location.href = '/login';
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const response = await api.post<{ shop: Shop }>('/shops', formData);
      await checkAuth(); // Refresh user data to include new shop
      navigate({ to: '/seller/dashboard' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create shop');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-display font-bold text-gray-900">Open Your Shop</h1>
        <p className="text-gray-600 mt-2">Start selling your handmade and vintage items</p>
      </div>

      <div className="card p-8">
        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="bg-red-50 text-red-600 p-3 rounded-md text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Shop Name *
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="input"
              required
              placeholder="e.g., Sarah's Handmade Jewelry"
            />
            <p className="text-xs text-gray-500 mt-1">
              This will be visible to buyers and used in your shop URL
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description
            </label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="input min-h-[100px]"
              placeholder="Tell buyers about your shop and what makes your items special..."
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Location
            </label>
            <input
              type="text"
              value={formData.location}
              onChange={(e) => setFormData({ ...formData, location: e.target.value })}
              className="input"
              placeholder="e.g., Portland, Oregon"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Return Policy
            </label>
            <textarea
              value={formData.returnPolicy}
              onChange={(e) => setFormData({ ...formData, returnPolicy: e.target.value })}
              className="input min-h-[80px]"
              placeholder="Describe your return and refund policy..."
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="btn btn-primary w-full py-3"
          >
            {isLoading ? 'Creating Shop...' : 'Create Shop'}
          </button>
        </form>
      </div>
    </div>
  );
}
