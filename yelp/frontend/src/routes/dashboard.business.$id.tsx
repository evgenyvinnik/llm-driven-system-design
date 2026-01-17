import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { ArrowLeft, Save, Trash2 } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { StarRating } from '../../components/StarRating';
import { ReviewCard } from '../../components/ReviewCard';
import api from '../../services/api';
import type { Business, Review, Category } from '../../types';

export const Route = createFileRoute('/dashboard/business/$id')({
  component: ManageBusinessPage,
});

function ManageBusinessPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading: authLoading } = useAuthStore();
  const [business, setBusiness] = useState<Business | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'info' | 'reviews'>('info');

  const [form, setForm] = useState({
    name: '',
    description: '',
    address: '',
    city: '',
    state: '',
    zip_code: '',
    phone: '',
    website: '',
    email: '',
    price_level: 2,
  });

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login' });
    }
  }, [authLoading, isAuthenticated, navigate]);

  useEffect(() => {
    if (user && id) {
      loadData();
    }
  }, [user, id]);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [bizResponse, reviewsResponse, catResponse] = await Promise.all([
        api.get<{ business: Business }>(`/businesses/${id}`),
        api.get<{ reviews: Review[] }>(`/businesses/${id}/reviews`),
        api.get<{ categories: Category[] }>('/categories'),
      ]);

      setBusiness(bizResponse.business);
      setReviews(reviewsResponse.reviews);
      setCategories(catResponse.categories);

      setForm({
        name: bizResponse.business.name,
        description: bizResponse.business.description || '',
        address: bizResponse.business.address,
        city: bizResponse.business.city,
        state: bizResponse.business.state,
        zip_code: bizResponse.business.zip_code,
        phone: bizResponse.business.phone || '',
        website: bizResponse.business.website || '',
        email: bizResponse.business.email || '',
        price_level: bizResponse.business.price_level || 2,
      });
    } catch (err) {
      console.error('Failed to load business:', err);
      setError('Failed to load business data');
    } finally {
      setIsLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setIsSaving(true);

    try {
      await api.patch(`/businesses/${id}`, {
        ...form,
        price_level: parseInt(String(form.price_level)),
      });
      setSuccess('Business updated successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update business');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRespondToReview = async (reviewId: string, responseText: string) => {
    try {
      await api.post(`/reviews/${reviewId}/respond`, { text: responseText });
      // Refresh reviews
      const response = await api.get<{ reviews: Review[] }>(`/businesses/${id}/reviews`);
      setReviews(response.reviews);
    } catch (err) {
      console.error('Failed to respond:', err);
    }
  };

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  if (!business) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">Business not found</h1>
        <Link to="/dashboard" className="text-yelp-red hover:underline mt-4 inline-block">
          Back to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <Link to="/dashboard" className="text-gray-600 hover:text-gray-900">
          <ArrowLeft className="w-6 h-6" />
        </Link>
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{business.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <StarRating rating={business.rating} size="sm" />
            <span className="text-gray-600">{business.review_count} reviews</span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b mb-6">
        <div className="flex gap-4">
          <button
            onClick={() => setActiveTab('info')}
            className={`pb-4 px-2 border-b-2 transition-colors ${
              activeTab === 'info'
                ? 'border-yelp-red text-yelp-red'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            Business Info
          </button>
          <button
            onClick={() => setActiveTab('reviews')}
            className={`pb-4 px-2 border-b-2 transition-colors ${
              activeTab === 'reviews'
                ? 'border-yelp-red text-yelp-red'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            Reviews ({business.review_count})
          </button>
        </div>
      </div>

      {activeTab === 'info' ? (
        <form onSubmit={handleSave} className="bg-white rounded-lg shadow p-8">
          {success && (
            <div className="bg-green-50 text-green-600 px-4 py-3 rounded-md text-sm mb-6">
              {success}
            </div>
          )}

          {error && (
            <div className="bg-red-50 text-red-600 px-4 py-3 rounded-md text-sm mb-6">
              {error}
            </div>
          )}

          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Business Name
                </label>
                <input
                  type="text"
                  name="name"
                  value={form.name}
                  onChange={handleChange}
                  className="input-field"
                  required
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <textarea
                  name="description"
                  value={form.description}
                  onChange={handleChange}
                  className="input-field h-24"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Phone
                </label>
                <input
                  type="tel"
                  name="phone"
                  value={form.phone}
                  onChange={handleChange}
                  className="input-field"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Website
                </label>
                <input
                  type="url"
                  name="website"
                  value={form.website}
                  onChange={handleChange}
                  className="input-field"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  name="email"
                  value={form.email}
                  onChange={handleChange}
                  className="input-field"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Price Level
                </label>
                <select
                  name="price_level"
                  value={form.price_level}
                  onChange={handleChange}
                  className="input-field"
                >
                  <option value={1}>$ - Budget</option>
                  <option value={2}>$$ - Moderate</option>
                  <option value={3}>$$$ - Upscale</option>
                  <option value={4}>$$$$ - Premium</option>
                </select>
              </div>
            </div>

            <div>
              <h3 className="font-medium text-gray-700 mb-2">Address</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <input
                    type="text"
                    name="address"
                    value={form.address}
                    onChange={handleChange}
                    className="input-field"
                    placeholder="Street Address"
                    required
                  />
                </div>
                <input
                  type="text"
                  name="city"
                  value={form.city}
                  onChange={handleChange}
                  className="input-field"
                  placeholder="City"
                  required
                />
                <div className="flex gap-2">
                  <input
                    type="text"
                    name="state"
                    value={form.state}
                    onChange={handleChange}
                    className="input-field"
                    placeholder="State"
                    required
                  />
                  <input
                    type="text"
                    name="zip_code"
                    value={form.zip_code}
                    onChange={handleChange}
                    className="input-field"
                    placeholder="ZIP"
                    required
                  />
                </div>
              </div>
            </div>

            <div className="flex gap-4">
              <button
                type="submit"
                disabled={isSaving}
                className="btn-primary flex items-center gap-2 disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                {isSaving ? 'Saving...' : 'Save Changes'}
              </button>
              <Link
                to="/business/$slug"
                params={{ slug: business.slug }}
                className="btn-outline"
              >
                View Public Page
              </Link>
            </div>
          </div>
        </form>
      ) : (
        <div className="space-y-6">
          {reviews.length > 0 ? (
            reviews.map((review) => (
              <div key={review.id} className="bg-white rounded-lg shadow p-6">
                <ReviewCard review={review} />
                {!review.response_text && (
                  <div className="mt-4 pt-4 border-t">
                    <ResponseForm
                      onSubmit={(text) => handleRespondToReview(review.id, text)}
                    />
                  </div>
                )}
              </div>
            ))
          ) : (
            <div className="text-center py-12 bg-white rounded-lg shadow">
              <p className="text-gray-600">No reviews yet</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResponseForm({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [text, setText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setIsSubmitting(true);
    await onSubmit(text);
    setText('');
    setIsSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit}>
      <label className="block text-sm font-medium text-gray-700 mb-2">
        Respond to this review
      </label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="input-field h-20 mb-2"
        placeholder="Write your response..."
      />
      <button
        type="submit"
        disabled={!text.trim() || isSubmitting}
        className="btn-primary text-sm disabled:opacity-50"
      >
        {isSubmitting ? 'Posting...' : 'Post Response'}
      </button>
    </form>
  );
}
