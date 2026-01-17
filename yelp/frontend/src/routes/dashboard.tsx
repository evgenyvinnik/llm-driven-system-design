import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { Store, Plus, Settings, Star, MessageSquare } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { StarRating } from '../components/StarRating';
import api from '../services/api';
import type { Business, Review } from '../types';

export const Route = createFileRoute('/dashboard')({
  component: DashboardPage,
});

function DashboardPage() {
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading: authLoading } = useAuthStore();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'businesses' | 'reviews'>('businesses');

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login' });
    }
  }, [authLoading, isAuthenticated, navigate]);

  useEffect(() => {
    if (user) {
      loadData();
    }
  }, [user]);

  const loadData = async () => {
    if (!user) return;
    setIsLoading(true);
    try {
      const [bizResponse, reviewsResponse] = await Promise.all([
        api.get<{ businesses: Business[] }>(`/users/${user.id}/businesses`),
        api.get<{ reviews: Review[] }>(`/users/${user.id}/reviews`),
      ]);
      setBusinesses(bizResponse.businesses);
      setReviews(reviewsResponse.reviews);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (authLoading || !isAuthenticated) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-gray-600 mt-1">Welcome back, {user?.name}!</p>
        </div>
        {(user?.role === 'business_owner' || user?.role === 'admin') && (
          <Link to="/dashboard/business/new" className="btn-primary flex items-center gap-2">
            <Plus className="w-5 h-5" />
            Add Business
          </Link>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b mb-6">
        <div className="flex gap-4">
          <button
            onClick={() => setActiveTab('businesses')}
            className={`pb-4 px-2 border-b-2 transition-colors ${
              activeTab === 'businesses'
                ? 'border-yelp-red text-yelp-red'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            <span className="flex items-center gap-2">
              <Store className="w-5 h-5" />
              My Businesses
            </span>
          </button>
          <button
            onClick={() => setActiveTab('reviews')}
            className={`pb-4 px-2 border-b-2 transition-colors ${
              activeTab === 'reviews'
                ? 'border-yelp-red text-yelp-red'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            <span className="flex items-center gap-2">
              <MessageSquare className="w-5 h-5" />
              My Reviews
            </span>
          </button>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="animate-pulse space-y-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-24 bg-gray-200 rounded" />
          ))}
        </div>
      ) : activeTab === 'businesses' ? (
        <div>
          {businesses.length > 0 ? (
            <div className="space-y-4">
              {businesses.map((business) => (
                <div
                  key={business.id}
                  className="bg-white rounded-lg shadow p-6 flex items-center gap-6"
                >
                  <img
                    src={business.photo_url || 'https://via.placeholder.com/100'}
                    alt={business.name}
                    className="w-24 h-24 object-cover rounded-lg"
                  />
                  <div className="flex-1">
                    <Link
                      to="/business/$slug"
                      params={{ slug: business.slug }}
                      className="text-xl font-semibold text-yelp-blue hover:underline"
                    >
                      {business.name}
                    </Link>
                    <div className="flex items-center gap-4 mt-2">
                      <StarRating rating={business.rating} size="sm" />
                      <span className="text-gray-600">{business.review_count} reviews</span>
                    </div>
                    <p className="text-gray-600 mt-1">
                      {business.city}, {business.state}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Link
                      to="/dashboard/business/$id"
                      params={{ id: business.id }}
                      className="btn-outline flex items-center gap-2"
                    >
                      <Settings className="w-4 h-4" />
                      Manage
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 bg-white rounded-lg shadow">
              <Store className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-gray-900 mb-2">No businesses yet</h3>
              <p className="text-gray-600 mb-4">
                Add your first business to get started
              </p>
              <Link to="/dashboard/business/new" className="btn-primary">
                Add Business
              </Link>
            </div>
          )}
        </div>
      ) : (
        <div>
          {reviews.length > 0 ? (
            <div className="space-y-4">
              {reviews.map((review) => (
                <div key={review.id} className="bg-white rounded-lg shadow p-6">
                  <div className="flex items-start gap-4">
                    {review.business_photo && (
                      <img
                        src={review.business_photo}
                        alt={review.business_name}
                        className="w-20 h-20 object-cover rounded"
                      />
                    )}
                    <div className="flex-1">
                      <Link
                        to="/business/$slug"
                        params={{ slug: review.business_slug || '' }}
                        className="font-semibold text-yelp-blue hover:underline"
                      >
                        {review.business_name}
                      </Link>
                      <p className="text-sm text-gray-600">{review.business_city}</p>
                      <div className="flex items-center gap-2 mt-2">
                        <StarRating rating={review.rating} size="sm" />
                        <span className="text-sm text-gray-500">
                          {new Date(review.created_at).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="mt-2 text-gray-700 line-clamp-2">{review.text}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 bg-white rounded-lg shadow">
              <Star className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-gray-900 mb-2">No reviews yet</h3>
              <p className="text-gray-600 mb-4">
                Start reviewing businesses you've visited
              </p>
              <Link to="/search" className="btn-primary">
                Find Businesses
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
