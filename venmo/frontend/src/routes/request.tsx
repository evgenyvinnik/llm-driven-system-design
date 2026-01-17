/**
 * Request page component for creating and managing payment requests.
 * Provides tabbed interface for creating requests, viewing received requests, and sent requests.
 */

import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useRequestsStore } from '../stores';
import {
  CreateRequestForm,
  ReceivedRequests,
  SentRequests,
} from '../components/request';

/** Tab options for the request page */
type RequestTab = 'create' | 'received' | 'sent';

/**
 * Main request page component.
 * Displays tabbed navigation for creating, receiving, and sending payment requests.
 */
function RequestPage() {
  const [activeTab, setActiveTab] = useState<RequestTab>('create');
  const { sent, received, isLoading, loadRequests } = useRequestsStore();

  /**
   * Load requests on component mount.
   */
  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  /** Count of pending received requests for badge display */
  const pendingCount = received.filter((r) => r.status === 'pending').length;

  return (
    <div className="max-w-md mx-auto">
      <RequestTabNavigation
        activeTab={activeTab}
        onTabChange={setActiveTab}
        pendingCount={pendingCount}
      />

      <RequestTabContent
        activeTab={activeTab}
        sent={sent}
        received={received}
        isLoading={isLoading}
        onUpdate={loadRequests}
      />
    </div>
  );
}

/**
 * Props for the RequestTabNavigation component.
 */
interface RequestTabNavigationProps {
  /** Currently active tab */
  activeTab: RequestTab;
  /** Callback when tab changes */
  onTabChange: (tab: RequestTab) => void;
  /** Number of pending requests to show in badge */
  pendingCount: number;
}

/** Tab configuration for display labels */
const tabLabels: Record<RequestTab, string> = {
  create: 'Request Money',
  received: 'Received',
  sent: 'Sent',
};

/**
 * Renders the tab navigation buttons with optional pending badge.
 */
function RequestTabNavigation({
  activeTab,
  onTabChange,
  pendingCount,
}: RequestTabNavigationProps) {
  const tabs: RequestTab[] = ['create', 'received', 'sent'];

  return (
    <div className="flex gap-2 mb-6 overflow-x-auto">
      {tabs.map((tab) => (
        <button
          key={tab}
          onClick={() => onTabChange(tab)}
          className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
            activeTab === tab
              ? 'bg-venmo-blue text-white'
              : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          {tabLabels[tab]}
          {tab === 'received' && pendingCount > 0 && (
            <PendingBadge count={pendingCount} />
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Props for the PendingBadge component.
 */
interface PendingBadgeProps {
  /** Number of pending items */
  count: number;
}

/**
 * Renders a small red badge showing the pending count.
 */
function PendingBadge({ count }: PendingBadgeProps) {
  return (
    <span className="ml-1 bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full">
      {count}
    </span>
  );
}

/**
 * Props for the RequestTabContent component.
 */
interface RequestTabContentProps {
  /** Currently active tab */
  activeTab: RequestTab;
  /** List of sent requests */
  sent: import('../types').PaymentRequest[];
  /** List of received requests */
  received: import('../types').PaymentRequest[];
  /** Whether data is loading */
  isLoading: boolean;
  /** Callback to refresh requests */
  onUpdate: () => void;
}

/**
 * Renders the content for the currently active tab.
 */
function RequestTabContent({
  activeTab,
  sent,
  received,
  isLoading,
  onUpdate,
}: RequestTabContentProps) {
  switch (activeTab) {
    case 'create':
      return <CreateRequestForm onSuccess={onUpdate} />;
    case 'received':
      return (
        <ReceivedRequests
          requests={received}
          isLoading={isLoading}
          onUpdate={onUpdate}
        />
      );
    case 'sent':
      return (
        <SentRequests
          requests={sent}
          isLoading={isLoading}
          onUpdate={onUpdate}
        />
      );
    default:
      return null;
  }
}

export const Route = createFileRoute('/request')({
  component: RequestPage,
});
