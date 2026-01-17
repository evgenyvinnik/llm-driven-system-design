import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { SystemStats, SyncOperation, Conflict } from '../types';
import { CenteredSpinner } from './common';
import { OverviewTab, OperationsTab, ConflictsTab, UsersTab } from './admin';

/**
 * Tab identifiers for the admin dashboard navigation.
 */
type AdminTab = 'overview' | 'operations' | 'conflicts' | 'users';

/**
 * Admin dashboard component for system monitoring and management.
 *
 * Provides administrative functionality including:
 * - **Overview Tab**: System-wide statistics (users, files, photos, devices, sync, storage)
 * - **Operations Tab**: Recent sync operations with status and timing
 * - **Conflicts Tab**: Unresolved file conflicts across all users
 * - **Users Tab**: User list with search and storage usage
 *
 * Also includes maintenance actions:
 * - Cleanup orphaned chunks (storage optimization)
 * - Purge soft-deleted files older than 30 days
 *
 * Data is loaded on mount and can be refreshed manually via the Refresh button.
 *
 * @example
 * ```tsx
 * <AdminDashboard />
 * ```
 *
 * @returns Admin dashboard with tabbed navigation
 */
export const AdminDashboard: React.FC = () => {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [operations, setOperations] = useState<SyncOperation[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');
  const [isCleaningUp, setIsCleaningUp] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  /**
   * Loads all admin dashboard data from the API.
   * Fetches stats, operations, and conflicts in parallel.
   */
  const loadData = async () => {
    setIsLoading(true);
    try {
      const [statsData, opsData, conflictsData] = await Promise.all([
        api.getStats(),
        api.getSyncOperations({ limit: 50 }),
        api.getAdminConflicts(),
      ]);

      setStats(statsData);
      setOperations(opsData.operations);
      setConflicts(conflictsData.conflicts);
    } catch (error) {
      console.error('Failed to load admin data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Handles the cleanup orphaned chunks action.
   * Prompts for confirmation before executing.
   */
  const handleCleanupChunks = async () => {
    if (!confirm('Cleanup orphaned chunks? This cannot be undone.')) return;

    setIsCleaningUp(true);
    try {
      const result = await api.cleanupChunks();
      alert(`Cleaned up ${result.chunksRemoved} orphaned chunks`);
      await loadData();
    } catch (error) {
      console.error('Cleanup failed:', error);
      alert('Cleanup failed');
    } finally {
      setIsCleaningUp(false);
    }
  };

  /**
   * Handles the purge deleted files action.
   * Prompts for confirmation before executing.
   */
  const handlePurgeDeleted = async () => {
    if (!confirm('Permanently delete files that have been in trash for 30+ days?')) return;

    setIsCleaningUp(true);
    try {
      const result = await api.purgeDeleted(30);
      alert(`Purged ${result.filesDeleted} files, removed ${result.chunksRemoved} chunks`);
      await loadData();
    } catch (error) {
      console.error('Purge failed:', error);
      alert('Purge failed');
    } finally {
      setIsCleaningUp(false);
    }
  };

  if (isLoading) {
    return <CenteredSpinner />;
  }

  return (
    <div className="p-6">
      <DashboardHeader onRefresh={loadData} />
      <TabNavigation
        activeTab={activeTab}
        onTabChange={setActiveTab}
        conflictCount={conflicts.length}
      />
      <TabContent
        activeTab={activeTab}
        stats={stats}
        operations={operations}
        conflicts={conflicts}
        isCleaningUp={isCleaningUp}
        onCleanupChunks={handleCleanupChunks}
        onPurgeDeleted={handlePurgeDeleted}
      />
    </div>
  );
};

/**
 * Props for the DashboardHeader component.
 */
interface DashboardHeaderProps {
  /** Callback when refresh button is clicked */
  onRefresh: () => void;
}

/**
 * Header section of the admin dashboard.
 *
 * Displays the title and refresh button.
 *
 * @param props - Component props
 * @returns Header with title and refresh button
 */
const DashboardHeader: React.FC<DashboardHeaderProps> = ({ onRefresh }) => (
  <div className="flex items-center justify-between mb-6">
    <h1 className="text-2xl font-bold">Admin Dashboard</h1>
    <button
      onClick={onRefresh}
      className="px-3 py-1.5 text-sm bg-gray-100 rounded hover:bg-gray-200"
    >
      Refresh
    </button>
  </div>
);

/**
 * Props for the TabNavigation component.
 */
interface TabNavigationProps {
  /** Currently active tab */
  activeTab: AdminTab;
  /** Callback when tab is changed */
  onTabChange: (tab: AdminTab) => void;
  /** Number of conflicts to display as badge */
  conflictCount: number;
}

/**
 * Tab navigation for the admin dashboard.
 *
 * Displays tabs for Overview, Operations, Conflicts, and Users.
 * Shows a badge on the Conflicts tab when there are unresolved conflicts.
 *
 * @param props - Component props
 * @returns Tab navigation bar
 */
const TabNavigation: React.FC<TabNavigationProps> = ({
  activeTab,
  onTabChange,
  conflictCount,
}) => {
  const tabs: AdminTab[] = ['overview', 'operations', 'conflicts', 'users'];

  return (
    <div className="flex gap-4 border-b mb-6">
      {tabs.map((tab) => (
        <button
          key={tab}
          className={`px-4 py-2 -mb-px ${
            activeTab === tab
              ? 'border-b-2 border-blue-500 text-blue-600'
              : 'text-gray-500 hover:text-gray-700'
          }`}
          onClick={() => onTabChange(tab)}
        >
          {tab.charAt(0).toUpperCase() + tab.slice(1)}
          {tab === 'conflicts' && conflictCount > 0 && (
            <span className="ml-2 px-2 py-0.5 text-xs bg-red-100 text-red-600 rounded-full">
              {conflictCount}
            </span>
          )}
        </button>
      ))}
    </div>
  );
};

/**
 * Props for the TabContent component.
 */
interface TabContentProps {
  /** Currently active tab */
  activeTab: AdminTab;
  /** System statistics (null if not loaded) */
  stats: SystemStats | null;
  /** List of sync operations */
  operations: SyncOperation[];
  /** List of unresolved conflicts */
  conflicts: Conflict[];
  /** Whether cleanup/purge is in progress */
  isCleaningUp: boolean;
  /** Handler for cleanup chunks action */
  onCleanupChunks: () => void;
  /** Handler for purge deleted action */
  onPurgeDeleted: () => void;
}

/**
 * Renders the content for the currently active tab.
 *
 * @param props - Component props
 * @returns Active tab content
 */
const TabContent: React.FC<TabContentProps> = ({
  activeTab,
  stats,
  operations,
  conflicts,
  isCleaningUp,
  onCleanupChunks,
  onPurgeDeleted,
}) => {
  switch (activeTab) {
    case 'overview':
      return stats ? (
        <OverviewTab
          stats={stats}
          isCleaningUp={isCleaningUp}
          onCleanupChunks={onCleanupChunks}
          onPurgeDeleted={onPurgeDeleted}
        />
      ) : null;
    case 'operations':
      return <OperationsTab operations={operations} />;
    case 'conflicts':
      return <ConflictsTab conflicts={conflicts} />;
    case 'users':
      return <UsersTab />;
    default:
      return null;
  }
};
