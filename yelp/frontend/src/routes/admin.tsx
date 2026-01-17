/**
 * Admin Dashboard Page Route
 *
 * Provides administrative functionality for managing users, businesses,
 * and reviews. Only accessible to users with the 'admin' role.
 *
 * @module routes/admin
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { Store, Users, MessageSquare, TrendingUp } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import api from '../services/api';
import type { AdminStats, User, Business, Review } from '../types';
import {
  AdminTabs,
  OverviewTab,
  UsersTab,
  BusinessesTab,
  ReviewsTab,
  type TabConfig,
} from '../components/admin';

export const Route = createFileRoute('/admin')({
  component: AdminPage,
});

/** Tab configuration for the admin dashboard */
const ADMIN_TABS: TabConfig[] = [
  { key: 'overview', label: 'Overview', icon: TrendingUp },
  { key: 'users', label: 'Users', icon: Users },
  { key: 'businesses', label: 'Businesses', icon: Store },
  { key: 'reviews', label: 'Reviews', icon: MessageSquare },
];

/** Possible tab key values */
type TabKey = 'overview' | 'users' | 'businesses' | 'reviews';

/**
 * AdminPage is the main admin dashboard component.
 * It handles authentication checks and renders the appropriate
 * tab content based on user selection.
 *
 * @returns The admin dashboard page
 */
function AdminPage() {
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading: authLoading } = useAuthStore();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [searchQuery, setSearchQuery] = useState('');

  // Redirect non-admin users
  useEffect(() => {
    if (!authLoading) {
      if (!isAuthenticated) {
        navigate({ to: '/login' });
      } else if (user?.role !== 'admin') {
        navigate({ to: '/' });
      }
    }
  }, [authLoading, isAuthenticated, user, navigate]);

  // Load data when tab changes
  useEffect(() => {
    if (user?.role === 'admin') {
      loadData();
    }
  }, [user, activeTab]);

  /**
   * Loads data for the currently active tab.
   */
  const loadData = async () => {
    setIsLoading(true);
    try {
      switch (activeTab) {
        case 'overview':
          const statsResponse = await api.get<AdminStats>('/admin/stats');
          setStats(statsResponse);
          break;
        case 'users':
          const usersResponse = await api.get<{ users: User[] }>('/admin/users');
          setUsers(usersResponse.users);
          break;
        case 'businesses':
          const bizResponse = await api.get<{ businesses: Business[] }>('/admin/businesses');
          setBusinesses(bizResponse.businesses);
          break;
        case 'reviews':
          const reviewsResponse = await api.get<{ reviews: Review[] }>('/admin/reviews');
          setReviews(reviewsResponse.reviews);
          break;
      }
    } catch (error) {
      console.error('Failed to load admin data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Toggles the verification status of a business.
   *
   * @param businessId - ID of the business to verify/unverify
   * @param verified - New verification status
   */
  const handleVerifyBusiness = async (businessId: string, verified: boolean) => {
    try {
      await api.patch(`/admin/businesses/${businessId}/verify`, { verified });
      setBusinesses(
        businesses.map((b) => (b.id === businessId ? { ...b, is_verified: verified } : b))
      );
    } catch (error) {
      console.error('Failed to verify business:', error);
    }
  };

  /**
   * Deletes a review by ID.
   *
   * @param reviewId - ID of the review to delete
   */
  const handleDeleteReview = async (reviewId: string) => {
    try {
      await api.delete(`/admin/reviews/${reviewId}`);
      setReviews(reviews.filter((r) => r.id !== reviewId));
    } catch (error) {
      console.error('Failed to delete review:', error);
    }
  };

  /**
   * Updates a user's role.
   *
   * @param userId - ID of the user to update
   * @param role - New role to assign
   */
  const handleUpdateUserRole = async (userId: string, role: string) => {
    try {
      await api.patch(`/admin/users/${userId}/role`, { role });
      setUsers(users.map((u) => (u.id === userId ? { ...u, role: role as User['role'] } : u)));
    } catch (error) {
      console.error('Failed to update user role:', error);
    }
  };

  /**
   * Handles tab change and resets search query.
   */
  const handleTabChange = (tabKey: string) => {
    setActiveTab(tabKey as TabKey);
    setSearchQuery(''); // Reset search when switching tabs
  };

  // Show loading state while checking auth
  if (authLoading || !isAuthenticated || user?.role !== 'admin') {
    return <LoadingSkeleton />;
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold text-gray-900 mb-8">Admin Dashboard</h1>

      <AdminTabs tabs={ADMIN_TABS} activeTab={activeTab} onTabChange={handleTabChange} />

      {isLoading ? (
        <TabLoadingSkeleton />
      ) : (
        <TabContent
          activeTab={activeTab}
          stats={stats}
          users={users}
          businesses={businesses}
          reviews={reviews}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onVerifyBusiness={handleVerifyBusiness}
          onDeleteReview={handleDeleteReview}
          onUpdateUserRole={handleUpdateUserRole}
        />
      )}
    </div>
  );
}

/**
 * Props for TabContent component.
 */
interface TabContentProps {
  activeTab: TabKey;
  stats: AdminStats | null;
  users: User[];
  businesses: Business[];
  reviews: Review[];
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onVerifyBusiness: (businessId: string, verified: boolean) => void;
  onDeleteReview: (reviewId: string) => void;
  onUpdateUserRole: (userId: string, role: string) => void;
}

/**
 * TabContent renders the appropriate content for the active tab.
 *
 * @param props - Component properties
 * @returns Tab content component
 */
function TabContent({
  activeTab,
  stats,
  users,
  businesses,
  reviews,
  searchQuery,
  onSearchChange,
  onVerifyBusiness,
  onDeleteReview,
  onUpdateUserRole,
}: TabContentProps) {
  switch (activeTab) {
    case 'overview':
      return stats ? <OverviewTab stats={stats} /> : null;

    case 'users':
      return (
        <UsersTab
          users={users}
          searchQuery={searchQuery}
          onSearchChange={onSearchChange}
          onUpdateRole={onUpdateUserRole}
        />
      );

    case 'businesses':
      return (
        <BusinessesTab
          businesses={businesses}
          searchQuery={searchQuery}
          onSearchChange={onSearchChange}
          onVerifyBusiness={onVerifyBusiness}
        />
      );

    case 'reviews':
      return <ReviewsTab reviews={reviews} onDeleteReview={onDeleteReview} />;

    default:
      return null;
  }
}

/**
 * LoadingSkeleton displays a placeholder during auth checking.
 *
 * @returns Loading skeleton component
 */
function LoadingSkeleton() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-gray-200 rounded w-1/4" />
        <div className="h-64 bg-gray-200 rounded" />
      </div>
    </div>
  );
}

/**
 * TabLoadingSkeleton displays a placeholder while tab content loads.
 *
 * @returns Tab loading skeleton component
 */
function TabLoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="h-24 bg-gray-200 rounded" />
      ))}
    </div>
  );
}
