/**
 * @fileoverview Developer app management page route.
 * Provides detailed app editing, review management, and analytics for developers.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import {
  DeveloperAppHeader,
  AppDetailsTab,
  AppReviewsTab,
  AppAnalyticsTab,
} from '../components/developer';
import type { App, Review, RatingSummary } from '../types';
import api from '../services/api';

/** Developer app management page route definition */
export const Route = createFileRoute('/developer/app/$id')({
  component: DeveloperAppPage,
});

/** Tab options for the developer app page */
type TabType = 'details' | 'reviews' | 'analytics';

/**
 * Developer app management page component.
 * Provides tabs for app details editing, review responses, and analytics.
 * Requires developer or admin role for access.
 *
 * @returns Developer app management page with tabbed interface
 */
function DeveloperAppPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [app, setApp] = useState<App | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [ratings, setRatings] = useState<RatingSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>('details');
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
      const result = await api.post<{ data: Review }>(`/reviews/${reviewId}/respond`, {
        response,
      });
      setReviews(reviews.map((r) => (r.id === reviewId ? result.data : r)));
    } catch (error) {
      console.error('Failed to respond to review:', error);
    }
  };

  /**
   * Toggles the edit mode state.
   */
  const handleEditToggle = () => {
    setIsEditing(!isEditing);
  };

  /**
   * Cancels editing and resets edit data.
   */
  const handleCancelEdit = () => {
    setEditData(app || {});
    setIsEditing(false);
  };

  if (isLoading || !app) {
    return <LoadingState />;
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <DeveloperAppHeader
        app={app}
        isEditing={isEditing}
        onEditToggle={handleEditToggle}
        onPublish={handlePublish}
      />

      <TabNavigation activeTab={activeTab} onTabChange={setActiveTab} />

      <TabContent
        activeTab={activeTab}
        app={app}
        reviews={reviews}
        ratings={ratings}
        isEditing={isEditing}
        editData={editData}
        onEditDataChange={setEditData}
        onCancel={handleCancelEdit}
        onSave={handleSave}
        onRespondToReview={handleRespondToReview}
      />
    </div>
  );
}

/**
 * Displays loading skeleton while data is being fetched.
 *
 * @returns Loading placeholder UI
 */
function LoadingState() {
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
 * Props for the TabNavigation component.
 */
interface TabNavigationProps {
  /** Currently active tab */
  activeTab: TabType;
  /** Callback when tab changes */
  onTabChange: (tab: TabType) => void;
}

/**
 * Tab navigation component for switching between sections.
 *
 * @param props - Component props
 * @returns Tab navigation bar
 */
function TabNavigation({ activeTab, onTabChange }: TabNavigationProps) {
  const tabs: TabType[] = ['details', 'reviews', 'analytics'];

  return (
    <div className="flex gap-1 mb-6 border-b border-gray-200">
      {tabs.map((tab) => (
        <button
          key={tab}
          onClick={() => onTabChange(tab)}
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
  );
}

/**
 * Props for the TabContent component.
 */
interface TabContentProps {
  /** Currently active tab */
  activeTab: TabType;
  /** App data */
  app: App;
  /** Reviews for the app */
  reviews: Review[];
  /** Rating summary statistics */
  ratings: RatingSummary | null;
  /** Whether in edit mode */
  isEditing: boolean;
  /** Current edit form data */
  editData: Partial<App>;
  /** Callback when edit data changes */
  onEditDataChange: (data: Partial<App>) => void;
  /** Callback to cancel editing */
  onCancel: () => void;
  /** Callback to save changes */
  onSave: () => void;
  /** Callback to respond to a review */
  onRespondToReview: (reviewId: string, response: string) => void;
}

/**
 * Renders the active tab content.
 *
 * @param props - Component props
 * @returns Content for the active tab
 */
function TabContent({
  activeTab,
  app,
  reviews,
  ratings,
  isEditing,
  editData,
  onEditDataChange,
  onCancel,
  onSave,
  onRespondToReview,
}: TabContentProps) {
  switch (activeTab) {
    case 'details':
      return (
        <AppDetailsTab
          app={app}
          isEditing={isEditing}
          editData={editData}
          onEditDataChange={onEditDataChange}
          onCancel={onCancel}
          onSave={onSave}
        />
      );
    case 'reviews':
      return (
        <AppReviewsTab
          reviews={reviews}
          ratings={ratings}
          onRespondToReview={onRespondToReview}
        />
      );
    case 'analytics':
      return <AppAnalyticsTab app={app} reviews={reviews} />;
    default:
      return null;
  }
}
