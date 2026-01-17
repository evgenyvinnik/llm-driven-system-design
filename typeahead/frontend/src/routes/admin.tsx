import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import {
  TabButton,
  OverviewTab,
  AnalyticsTab,
  ManagementTab,
} from '../components/admin';

export const Route = createFileRoute('/admin')({
  component: AdminPage,
});

/**
 * AdminPage - The main admin dashboard page component.
 * Provides a tabbed interface for system monitoring and management.
 *
 * Tabs:
 * - Overview: System status, service health, and key metrics
 * - Analytics: Query volume charts and top phrases
 * - Management: Trie rebuilding, cache clearing, phrase management
 */
function AdminPage() {
  const [activeTab, setActiveTab] = useState<'overview' | 'analytics' | 'management'>('overview');

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Admin Dashboard</h1>
        <p className="text-gray-600 mt-2">Monitor and manage the typeahead service</p>
      </div>

      {/* Tab navigation */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="-mb-px flex space-x-8">
          <TabButton
            active={activeTab === 'overview'}
            onClick={() => setActiveTab('overview')}
          >
            Overview
          </TabButton>
          <TabButton
            active={activeTab === 'analytics'}
            onClick={() => setActiveTab('analytics')}
          >
            Analytics
          </TabButton>
          <TabButton
            active={activeTab === 'management'}
            onClick={() => setActiveTab('management')}
          >
            Management
          </TabButton>
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && <OverviewTab />}
      {activeTab === 'analytics' && <AnalyticsTab />}
      {activeTab === 'management' && <ManagementTab />}
    </div>
  );
}
