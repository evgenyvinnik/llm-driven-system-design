/**
 * Business Management Page Route
 *
 * Allows business owners to manage their business information and
 * respond to customer reviews. Requires authentication.
 *
 * @module routes/dashboard.business.$id
 */
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import api from '../services/api';
import type { Business, Review } from '../types';
import {
  BusinessManageHeader,
  ManagementTabs,
  BusinessInfoForm,
  BusinessReviewsManagement,
  type BusinessFormData,
} from '../components/dashboard';

export const Route = createFileRoute('/dashboard/business/$id')({
  component: ManageBusinessPage,
});

/**
 * ManageBusinessPage is the main route component for business owners
 * to edit their business information and manage reviews.
 *
 * @returns The business management page component
 */
function ManageBusinessPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading: authLoading } = useAuthStore();
  const [business, setBusiness] = useState<Business | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'info' | 'reviews'>('info');

  const [form, setForm] = useState<BusinessFormData>({
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

  // Redirect unauthenticated users
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login' });
    }
  }, [authLoading, isAuthenticated, navigate]);

  // Load business data
  useEffect(() => {
    if (user && id) {
      loadData();
    }
  }, [user, id]);

  /**
   * Loads business data and reviews from the API.
   */
  const loadData = async () => {
    setIsLoading(true);
    try {
      const [bizResponse, reviewsResponse] = await Promise.all([
        api.get<{ business: Business }>(`/businesses/${id}`),
        api.get<{ reviews: Review[] }>(`/businesses/${id}/reviews`),
      ]);

      setBusiness(bizResponse.business);
      setReviews(reviewsResponse.reviews);

      // Populate form with business data
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

  /**
   * Handles form field changes.
   *
   * @param e - Change event from form element
   */
  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setForm((prev: BusinessFormData) => ({ ...prev, [name]: value }));
  };

  /**
   * Saves the business information to the API.
   *
   * @param e - Form submit event
   */
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

  /**
   * Submits a response to a customer review.
   *
   * @param reviewId - ID of the review to respond to
   * @param responseText - Response text content
   */
  const handleRespondToReview = async (reviewId: string, responseText: string) => {
    try {
      await api.post(`/reviews/${reviewId}/respond`, { text: responseText });
      // Refresh reviews to show the new response
      const response = await api.get<{ reviews: Review[] }>(`/businesses/${id}/reviews`);
      setReviews(response.reviews);
    } catch (err) {
      console.error('Failed to respond:', err);
    }
  };

  // Loading state
  if (isLoading) {
    return <LoadingSkeleton />;
  }

  // Not found state
  if (!business) {
    return <BusinessNotFound />;
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <BusinessManageHeader business={business} />

      <ManagementTabs
        activeTab={activeTab}
        onTabChange={setActiveTab}
        reviewCount={business.review_count}
      />

      {activeTab === 'info' ? (
        <BusinessInfoForm
          formData={form}
          onChange={handleChange}
          onSubmit={handleSave}
          isSaving={isSaving}
          success={success}
          error={error}
          businessSlug={business.slug}
        />
      ) : (
        <BusinessReviewsManagement reviews={reviews} onRespond={handleRespondToReview} />
      )}
    </div>
  );
}

/**
 * LoadingSkeleton displays a placeholder while business data loads.
 *
 * @returns Loading skeleton component
 */
function LoadingSkeleton() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-gray-200 rounded w-1/3" />
        <div className="h-64 bg-gray-200 rounded" />
      </div>
    </div>
  );
}

/**
 * BusinessNotFound displays when a business cannot be found.
 *
 * @returns Not found message with link back to dashboard
 */
function BusinessNotFound() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-8 text-center">
      <h1 className="text-2xl font-bold text-gray-900">Business not found</h1>
      <Link to="/dashboard" className="text-yelp-red hover:underline mt-4 inline-block">
        Back to Dashboard
      </Link>
    </div>
  );
}
