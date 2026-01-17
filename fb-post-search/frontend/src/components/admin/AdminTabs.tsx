/**
 * @fileoverview Admin dashboard tab navigation component.
 * Provides tabbed interface for switching between overview, users, posts, and search history views.
 */

import { Database, Users, FileText, Search } from 'lucide-react';

/**
 * Supported admin dashboard tab identifiers.
 */
export type AdminTabId = 'overview' | 'users' | 'posts' | 'searches';

/**
 * Configuration for a single admin tab.
 */
interface TabConfig {
  /** Unique tab identifier */
  id: AdminTabId;
  /** Display label */
  label: string;
  /** Lucide icon component */
  icon: React.ComponentType<{ className?: string }>;
}

/**
 * Props for the AdminTabs component.
 */
interface AdminTabsProps {
  /** Currently active tab */
  activeTab: AdminTabId;
  /** Callback when a tab is selected */
  onTabChange: (tab: AdminTabId) => void;
}

/**
 * Tab configuration for the admin dashboard.
 */
const TABS: TabConfig[] = [
  { id: 'overview', label: 'Overview', icon: Database },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'posts', label: 'Posts', icon: FileText },
  { id: 'searches', label: 'Search History', icon: Search },
];

/**
 * Renders the tab navigation bar for the admin dashboard.
 * Highlights the active tab and handles tab selection.
 *
 * @param props - AdminTabs props
 * @returns Tab navigation bar component
 */
export function AdminTabs({ activeTab, onTabChange }: AdminTabsProps) {
  return (
    <div className="flex gap-2 mb-6 border-b border-gray-200">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={`flex items-center gap-2 px-4 py-3 border-b-2 -mb-px transition-colors ${
            activeTab === tab.id
              ? 'border-primary-500 text-primary-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          <tab.icon className="w-4 h-4" />
          {tab.label}
        </button>
      ))}
    </div>
  );
}
