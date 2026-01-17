/**
 * @fileoverview Developer app management page route.
 * Provides detailed app editing, review management, and analytics for developers.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { StarRating } from '../components/AppCard';
import { ReviewCard } from '../components/ReviewCard';
import type { App, Review, RatingSummary } from '../types';
import api from '../services/api';

/** Developer app management page route definition */
export const Route = createFileRoute('/developer/app/$id')({
  component: DeveloperAppPage,
});

/**
 * Developer app management page component.
 * Provides tabs for app details editing, review responses, and analytics.
 * Requires developer or admin role for access.
 */
function DeveloperAppPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [app, setApp] = useState<App | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [ratings, setRatings] = useState<RatingSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'details' | 'reviews' | 'analytics'>('details');
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<Partial<App>>({});

  useEffect(() => {
    if (!user || (user.role !== 'developer' && user.role !== 'admin')) {
      navigate({ to: '/login' });
      return;
    }

    fetchAppData();
  }, [id, user, navigate]);

  /**
   * Fetches all app data including details, reviews, and ratings.
   * Runs on component mount and when app ID changes.
   */
  const fetchAppData = async () => {
    try {
      const [appRes, reviewsRes, ratingsRes] = await Promise.all([
        api.get<{ data: App }>(`/apps/${id}`),
        api.get<{ data: Review[] }>(`/developer/apps/${id}/reviews`),
        api.get<{ data: RatingSummary }>(`/apps/${id}/ratings`),
      ]);
      setApp(appRes.data);
      setReviews(reviewsRes.data);
      setRatings(ratingsRes.data);
      setEditData(appRes.data);
    } catch (error) {
      console.error('Failed to fetch app data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Saves edited app metadata to the server.
   * Updates local state on success and exits edit mode.
   */
  const handleSave = async () => {
    try {
      const response = await api.put<{ data: App }>(`/developer/apps/${id}`, editData);
      setApp(response.data);
      setIsEditing(false);
    } catch (error) {
      console.error('Failed to update app:', error);
    }
  };

  /**
   * Submits the app for publishing/review.
   * Changes app status from draft to pending review.
   */
  const handlePublish = async () => {
    try {
      const response = await api.post<{ data: App }>(`/developer/apps/${id}/publish`);
      setApp(response.data);
    } catch (error) {
      console.error('Failed to publish app:', error);
    }
  };

  /**
   * Submits a developer response to a user review.
   * @param reviewId - ID of the review to respond to
   * @param response - Developer's response text
   */
  const handleRespondToReview = async (reviewId: string, response: string) => {
    try {
      const result = await api.post<{ data: Review }>(`/reviews/${reviewId}/respond`, { response });
      setReviews(reviews.map((r) => (r.id === reviewId ? result.data : r)));
    } catch (error) {
      console.error('Failed to respond to review:', error);
    }
  };

  if (isLoading || !app) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-8" />
          <div className="h-64 bg-gray-200 rounded-xl" />
        </div>
      </div>
    );
  }

  /**
   * Maps app status to corresponding Tailwind CSS color classes.
   * @param status - Current app status
   * @returns CSS class string for badge styling
   */
  const getStatusColor = (status: App['status']) => {
    const colors: Record<string, string> = {
      draft: 'bg-gray-100 text-gray-700',
      pending: 'bg-yellow-100 text-yellow-700',
      approved: 'bg-green-100 text-green-700',
      rejected: 'bg-red-100 text-red-700',
      published: 'bg-blue-100 text-blue-700',
      suspended: 'bg-red-100 text-red-700',
    };
    return colors[status] || 'bg-gray-100 text-gray-700';
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="flex items-start gap-6 mb-8">
        {app.iconUrl ? (
          <img src={app.iconUrl} alt={app.name} className="w-24 h-24 app-icon object-cover" />
        ) : (
          <div className="w-24 h-24 app-icon bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center text-white font-bold text-3xl">
            {app.name.charAt(0)}
          </div>
        )}

        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold text-gray-900">{app.name}</h1>
            <span className={`px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(app.status)}`}>
              {app.status}
            </span>
          </div>
          <p className="text-gray-500 mb-2">{app.bundleId}</p>
          <div className="flex items-center gap-4">
            <StarRating rating={app.averageRating} showValue />
            <span className="text-gray-400">|</span>
            <span className="text-gray-500">{app.downloadCount.toLocaleString()} downloads</span>
            <span className="text-gray-400">|</span>
            <span className="text-gray-500">v{app.version || '1.0'}</span>
          </div>
        </div>

        <div className="flex gap-3">
          {app.status === 'draft' && (
            <button onClick={handlePublish} className="btn btn-primary">
              Publish
            </button>
          )}
          <button
            onClick={() => setIsEditing(!isEditing)}
            className="btn btn-outline"
          >
            {isEditing ? 'Cancel' : 'Edit'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {(['details', 'reviews', 'analytics'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-3 font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab
                ? 'border-primary-600 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'details' && (
        <div className="card p-6">
          {isEditing ? (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">App Name</label>
                <input
                  type="text"
                  value={editData.name || ''}
                  onChange={(e) => setEditData({ ...editData, name: e.target.value })}
                  className="input"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Short Description</label>
                <input
                  type="text"
                  value={editData.shortDescription || ''}
                  onChange={(e) => setEditData({ ...editData, shortDescription: e.target.value })}
                  className="input"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={editData.description || ''}
                  onChange={(e) => setEditData({ ...editData, description: e.target.value })}
                  className="input min-h-[150px]"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Release Notes</label>
                <textarea
                  value={editData.releaseNotes || ''}
                  onChange={(e) => setEditData({ ...editData, releaseNotes: e.target.value })}
                  className="input min-h-[100px]"
                  placeholder="What's new in this version?"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Version</label>
                <input
                  type="text"
                  value={editData.version || ''}
                  onChange={(e) => setEditData({ ...editData, version: e.target.value })}
                  className="input"
                  placeholder="1.0.0"
                />
              </div>

              <div className="flex gap-3 pt-4">
                <button onClick={() => setIsEditing(false)} className="btn btn-secondary">
                  Cancel
                </button>
                <button onClick={handleSave} className="btn btn-primary">
                  Save Changes
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-medium text-gray-500 mb-1">Description</h3>
                <p className="text-gray-900 whitespace-pre-line">{app.description}</p>
              </div>

              {app.releaseNotes && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-1">Release Notes</h3>
                  <p className="text-gray-900">{app.releaseNotes}</p>
                </div>
              )}

              {app.keywords && app.keywords.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-2">Keywords</h3>
                  <div className="flex flex-wrap gap-2">
                    {app.keywords.map((keyword, i) => (
                      <span key={i} className="px-2 py-1 bg-gray-100 text-gray-600 rounded-full text-sm">
                        {keyword}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === 'reviews' && (
        <div className="card p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-xl font-bold text-gray-900">Reviews</h3>
              <p className="text-gray-500">{ratings?.totalRatings || 0} total reviews</p>
            </div>
            <div className="text-center">
              <div className="text-4xl font-bold text-gray-900">
                {ratings?.averageRating.toFixed(1) || '0.0'}
              </div>
              <StarRating rating={ratings?.averageRating || 0} />
            </div>
          </div>

          {reviews.length === 0 ? (
            <p className="text-center text-gray-500 py-8">No reviews yet</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {reviews.map((review) => (
                <div key={review.id} className="py-4">
                  <ReviewCard review={review} />
                  {!review.developerResponse && (
                    <ResponseForm
                      onSubmit={(response) => handleRespondToReview(review.id, response)}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'analytics' && (
        <div className="grid grid-cols-2 gap-6">
          <div className="card p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-4">Downloads</h3>
            <div className="text-4xl font-bold text-primary-600 mb-2">
              {app.downloadCount.toLocaleString()}
            </div>
            <p className="text-gray-500">Total downloads</p>
          </div>

          <div className="card p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-4">Revenue</h3>
            <div className="text-4xl font-bold text-green-600 mb-2">
              ${(app.isFree ? 0 : app.price * app.downloadCount * 0.7).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </div>
            <p className="text-gray-500">Estimated earnings (70% share)</p>
          </div>

          <div className="card p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-4">Rating</h3>
            <div className="flex items-center gap-3">
              <div className="text-4xl font-bold text-yellow-600">{app.averageRating.toFixed(1)}</div>
              <StarRating rating={app.averageRating} size="large" />
            </div>
            <p className="text-gray-500 mt-2">{app.ratingCount.toLocaleString()} ratings</p>
          </div>

          <div className="card p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-4">Reviews</h3>
            <div className="text-4xl font-bold text-blue-600 mb-2">
              {reviews.length}
            </div>
            <p className="text-gray-500">Written reviews</p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Inline form component for developer review responses.
 * Expands from a button to a full text area when activated.
 * @param onSubmit - Callback to handle response submission
 */
function ResponseForm({ onSubmit }: { onSubmit: (response: string) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const [response, setResponse] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (response.trim()) {
      onSubmit(response);
      setResponse('');
      setIsOpen(false);
    }
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="text-sm text-primary-600 hover:text-primary-700 mt-2"
      >
        Reply to this review
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 p-3 bg-gray-50 rounded-lg">
      <textarea
        value={response}
        onChange={(e) => setResponse(e.target.value)}
        className="input min-h-[80px] mb-2"
        placeholder="Write your response..."
      />
      <div className="flex gap-2">
        <button type="button" onClick={() => setIsOpen(false)} className="btn btn-secondary text-sm">
          Cancel
        </button>
        <button type="submit" className="btn btn-primary text-sm">
          Submit Response
        </button>
      </div>
    </form>
  );
}
