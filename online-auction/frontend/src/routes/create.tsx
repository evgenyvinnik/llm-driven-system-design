import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { api } from '../services/api';

export const Route = createFileRoute('/create')({
  component: CreateAuctionPage,
});

function CreateAuctionPage() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuthStore();

  const [formData, setFormData] = useState({
    title: '',
    description: '',
    starting_price: '',
    reserve_price: '',
    bid_increment: '1',
    duration_hours: '24',
    snipe_protection_minutes: '2',
  });
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isAuthenticated) {
    navigate({ to: '/login' });
    return null;
  }

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setImage(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!formData.title.trim()) {
      setError('Title is required');
      return;
    }

    if (!formData.starting_price || parseFloat(formData.starting_price) <= 0) {
      setError('Starting price must be greater than 0');
      return;
    }

    setIsSubmitting(true);

    try {
      const data = new FormData();
      data.append('title', formData.title);
      data.append('description', formData.description);
      data.append('starting_price', formData.starting_price);
      if (formData.reserve_price) {
        data.append('reserve_price', formData.reserve_price);
      }
      data.append('bid_increment', formData.bid_increment);
      data.append('duration_hours', formData.duration_hours);
      data.append('snipe_protection_minutes', formData.snipe_protection_minutes);
      if (image) {
        data.append('image', image);
      }

      const result = await api.createAuction(data);
      navigate({ to: '/auction/$auctionId', params: { auctionId: result.auction.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create auction');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold text-gray-900 mb-8">Create Auction</h1>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-md text-red-700">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Image Upload */}
        <div>
          <label className="label">Item Image</label>
          <div className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-gray-300 border-dashed rounded-md">
            {imagePreview ? (
              <div className="relative">
                <img
                  src={imagePreview}
                  alt="Preview"
                  className="max-h-48 rounded"
                />
                <button
                  type="button"
                  onClick={() => {
                    setImage(null);
                    setImagePreview(null);
                  }}
                  className="absolute top-0 right-0 -mt-2 -mr-2 bg-red-500 text-white rounded-full p-1"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ) : (
              <div className="space-y-1 text-center">
                <svg
                  className="mx-auto h-12 w-12 text-gray-400"
                  stroke="currentColor"
                  fill="none"
                  viewBox="0 0 48 48"
                >
                  <path
                    d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <div className="flex text-sm text-gray-600">
                  <label className="relative cursor-pointer rounded-md font-medium text-primary-600 hover:text-primary-500">
                    <span>Upload a file</span>
                    <input
                      type="file"
                      className="sr-only"
                      accept="image/*"
                      onChange={handleImageChange}
                    />
                  </label>
                  <p className="pl-1">or drag and drop</p>
                </div>
                <p className="text-xs text-gray-500">PNG, JPG, GIF up to 5MB</p>
              </div>
            )}
          </div>
        </div>

        {/* Title */}
        <div>
          <label htmlFor="title" className="label">
            Title *
          </label>
          <input
            type="text"
            id="title"
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            className="input"
            placeholder="What are you selling?"
            required
          />
        </div>

        {/* Description */}
        <div>
          <label htmlFor="description" className="label">
            Description
          </label>
          <textarea
            id="description"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            className="input"
            rows={4}
            placeholder="Describe your item in detail..."
          />
        </div>

        {/* Pricing */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="starting_price" className="label">
              Starting Price *
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">
                $
              </span>
              <input
                type="number"
                id="starting_price"
                value={formData.starting_price}
                onChange={(e) =>
                  setFormData({ ...formData, starting_price: e.target.value })
                }
                className="input pl-8"
                min="0.01"
                step="0.01"
                required
              />
            </div>
          </div>

          <div>
            <label htmlFor="reserve_price" className="label">
              Reserve Price (Optional)
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">
                $
              </span>
              <input
                type="number"
                id="reserve_price"
                value={formData.reserve_price}
                onChange={(e) =>
                  setFormData({ ...formData, reserve_price: e.target.value })
                }
                className="input pl-8"
                min="0"
                step="0.01"
              />
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Minimum price to sell. Hidden from bidders.
            </p>
          </div>
        </div>

        {/* Settings */}
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label htmlFor="bid_increment" className="label">
              Bid Increment
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">
                $
              </span>
              <input
                type="number"
                id="bid_increment"
                value={formData.bid_increment}
                onChange={(e) =>
                  setFormData({ ...formData, bid_increment: e.target.value })
                }
                className="input pl-8"
                min="0.01"
                step="0.01"
              />
            </div>
          </div>

          <div>
            <label htmlFor="duration_hours" className="label">
              Duration
            </label>
            <select
              id="duration_hours"
              value={formData.duration_hours}
              onChange={(e) =>
                setFormData({ ...formData, duration_hours: e.target.value })
              }
              className="input"
            >
              <option value="1">1 hour</option>
              <option value="6">6 hours</option>
              <option value="12">12 hours</option>
              <option value="24">1 day</option>
              <option value="72">3 days</option>
              <option value="168">7 days</option>
            </select>
          </div>

          <div>
            <label htmlFor="snipe_protection" className="label">
              Snipe Protection
            </label>
            <select
              id="snipe_protection"
              value={formData.snipe_protection_minutes}
              onChange={(e) =>
                setFormData({ ...formData, snipe_protection_minutes: e.target.value })
              }
              className="input"
            >
              <option value="0">None</option>
              <option value="1">1 minute</option>
              <option value="2">2 minutes</option>
              <option value="5">5 minutes</option>
            </select>
          </div>
        </div>

        {/* Submit */}
        <div className="flex gap-4">
          <button
            type="button"
            onClick={() => navigate({ to: '/' })}
            className="btn-secondary flex-1"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="btn-primary flex-1"
          >
            {isSubmitting ? 'Creating...' : 'Create Auction'}
          </button>
        </div>
      </form>
    </div>
  );
}
