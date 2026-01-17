import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Settings } from 'lucide-react';
import { Header } from '../components';
import { useAuthStore } from '../stores/authStore';
import { adminApi } from '../services/api';
import {
  AdminTabs,
  OverviewTab,
  ContentTab,
  UsersTab,
} from '../components/admin';
import type { AdminTabType, AdminStats, AdminContent } from '../components/admin';

/**
 * Admin dashboard page for platform management.
 * Provides overview statistics, content management, and user listing.
 * Restricted to users with admin role.
 *
 * Features:
 * - Overview tab with platform statistics and subscription breakdown
 * - Content tab with table of all content items and featured toggle
 * - Users tab with list of registered users
 * - Role-based access control (admin only)
 *
 * @returns Admin dashboard page with tabbed navigation
 */
function AdminPage() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [content, setContent] = useState<AdminContent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<AdminTabType>('overview');

  useEffect(() => {
    if (!user || user.role !== 'admin') {
      navigate({ to: '/' });
      return;
    }

    const loadData = async () => {
      try {
        const [statsData, contentData] = await Promise.all([
          adminApi.getStats() as Promise<AdminStats>,
          adminApi.getContent({ limit: 20 }) as Promise<{ content: AdminContent[] }>,
        ]);
        setStats(statsData);
        setContent(contentData.content);
      } catch (error) {
        console.error('Failed to load admin data:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [user, navigate]);

  /**
   * Toggles the featured status of a content item.
   * Updates local state optimistically after API call succeeds.
   *
   * @param contentId - ID of the content item to toggle
   */
  const handleToggleFeatured = async (contentId: string) => {
    try {
      await adminApi.toggleFeatured(contentId);
      setContent((prev) =>
        prev.map((c) =>
          c.id === contentId ? { ...c, featured: !c.featured } : c
        )
      );
    } catch (error) {
      console.error('Failed to toggle featured:', error);
    }
  };

  // Redirect non-admin users
  if (!user || user.role !== 'admin') {
    return null;
  }

  return (
    <>
      <Header />
      <main className="pt-24 px-8 lg:px-16 pb-16 min-h-screen">
        <AdminPageHeader />
        <AdminTabs activeTab={activeTab} onTabChange={setActiveTab} />

        {isLoading ? (
          <LoadingSpinner />
        ) : (
          <TabContent
            activeTab={activeTab}
            stats={stats}
            content={content}
            onToggleFeatured={handleToggleFeatured}
          />
        )}
      </main>
    </>
  );
}

/**
 * Admin page header with title and admin mode badge.
 *
 * @returns Header section with title and status indicator
 */
function AdminPageHeader() {
  return (
    <div className="flex items-center justify-between mb-8">
      <h1 className="text-3xl font-bold">Admin Dashboard</h1>
      <div className="flex items-center gap-2 px-4 py-2 bg-apple-blue/20 text-apple-blue rounded-lg">
        <Settings className="w-4 h-4" />
        Admin Mode
      </div>
    </div>
  );
}

/**
 * Full-page loading spinner for initial data load.
 *
 * @returns Centered spinning loader
 */
function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-24">
      <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-white"></div>
    </div>
  );
}

/**
 * Props for the TabContent component.
 */
interface TabContentProps {
  /** Currently active tab */
  activeTab: AdminTabType;
  /** Platform statistics (may be null before load) */
  stats: AdminStats | null;
  /** Content items for content tab */
  content: AdminContent[];
  /** Handler for featured toggle */
  onToggleFeatured: (contentId: string) => void;
}

/**
 * Renders the appropriate tab content based on active tab.
 * Conditionally renders OverviewTab, ContentTab, or UsersTab.
 *
 * @param props - TabContentProps with tab state and data
 * @returns Active tab's content component
 */
function TabContent({
  activeTab,
  stats,
  content,
  onToggleFeatured,
}: TabContentProps) {
  if (activeTab === 'overview' && stats) {
    return <OverviewTab stats={stats} recentContent={content} />;
  }

  if (activeTab === 'content') {
    return <ContentTab content={content} onToggleFeatured={onToggleFeatured} />;
  }

  if (activeTab === 'users') {
    return <UsersTab />;
  }

  return null;
}

/**
 * Route configuration for admin dashboard (/admin).
 * Platform management interface for admin users.
 */
export const Route = createFileRoute('/admin')({
  component: AdminPage,
});
