/**
 * @fileoverview Alerts management page.
 *
 * Provides UI for managing alert rules and viewing alert history.
 * Includes forms for creating rules and testing alert evaluation.
 *
 * This page is composed of several sub-components:
 * - AlertRuleForm: Form for creating new alert rules
 * - AlertRuleList: List of existing alert rules
 * - AlertHistoryTable: Table showing alert firing history
 */

import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useAlerts } from '../hooks/useAlerts';
import {
  AlertRuleForm,
  AlertRuleList,
  AlertHistoryTable,
  type AlertRuleFormData,
} from '../components/alerts';

/**
 * Route configuration for the alerts page.
 */
export const Route = createFileRoute('/alerts')({
  component: AlertsPage,
});

/**
 * Active tab type for switching between rules and history views.
 */
type AlertTab = 'rules' | 'instances';

/**
 * Alerts management page component.
 *
 * Features:
 * - List all alert rules with enable/disable toggle
 * - Create new alert rules with metric, condition, and severity
 * - View alert history with firing/resolved status
 * - Test alert rules with manual evaluation
 *
 * @returns The rendered alerts page
 */
function AlertsPage() {
  const [activeTab, setActiveTab] = useState<AlertTab>('rules');
  const [showCreate, setShowCreate] = useState(false);

  const {
    rules,
    instances,
    loading,
    error,
    clearError,
    createRule,
    deleteRule,
    toggleRule,
    evaluateRule,
  } = useAlerts();

  /**
   * Handles successful form submission.
   * Creates the alert rule and hides the form.
   *
   * @param data - Form data for the new alert rule
   */
  const handleCreate = async (data: AlertRuleFormData) => {
    await createRule(data);
    setShowCreate(false);
  };

  // Show loading state only on initial load
  if (loading && rules.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-dashboard-muted">Loading alerts...</div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Header with title and create button */}
      <AlertsHeader
        showCreate={showCreate}
        onToggleCreate={() => setShowCreate(!showCreate)}
      />

      {/* Error message display */}
      {error && (
        <ErrorBanner message={error} onDismiss={clearError} />
      )}

      {/* Create form (conditionally rendered) */}
      {showCreate && (
        <AlertRuleForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {/* Tab navigation */}
      <AlertTabs
        activeTab={activeTab}
        rulesCount={rules.length}
        instancesCount={instances.length}
        onTabChange={setActiveTab}
      />

      {/* Tab content */}
      {activeTab === 'rules' && (
        <AlertRuleList
          rules={rules}
          onToggle={toggleRule}
          onEvaluate={evaluateRule}
          onDelete={deleteRule}
        />
      )}

      {activeTab === 'instances' && (
        <AlertHistoryTable instances={instances} rules={rules} />
      )}
    </div>
  );
}

// ============================================================================
// Local Sub-components
// ============================================================================

/**
 * Props for the AlertsHeader component.
 */
interface AlertsHeaderProps {
  /** Whether the create form is currently visible */
  showCreate: boolean;
  /** Callback to toggle create form visibility */
  onToggleCreate: () => void;
}

/**
 * Renders the page header with title and create button.
 *
 * @param props - Component props
 * @returns The rendered header
 */
function AlertsHeader({ showCreate, onToggleCreate }: AlertsHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-8">
      <h1 className="text-2xl font-bold text-dashboard-text">Alerts</h1>
      <button
        onClick={onToggleCreate}
        className="bg-dashboard-highlight hover:bg-dashboard-highlight/80 text-white px-4 py-2 rounded-md text-sm font-medium"
      >
        {showCreate ? 'Cancel' : 'New Alert Rule'}
      </button>
    </div>
  );
}

/**
 * Props for the ErrorBanner component.
 */
interface ErrorBannerProps {
  /** Error message to display */
  message: string;
  /** Callback to dismiss the error */
  onDismiss?: () => void;
}

/**
 * Renders an error message banner.
 *
 * @param props - Component props
 * @returns The rendered error banner
 */
function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  return (
    <div className="bg-red-900/50 border border-red-700 rounded-md px-4 py-2 mb-4 text-red-200 flex items-center justify-between">
      <span>{message}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="text-red-200 hover:text-white ml-4"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

/**
 * Props for the AlertTabs component.
 */
interface AlertTabsProps {
  /** Currently active tab */
  activeTab: AlertTab;
  /** Number of alert rules */
  rulesCount: number;
  /** Number of alert instances */
  instancesCount: number;
  /** Callback when tab selection changes */
  onTabChange: (tab: AlertTab) => void;
}

/**
 * Renders tab navigation for switching between rules and history views.
 *
 * @param props - Component props
 * @returns The rendered tab navigation
 */
function AlertTabs({ activeTab, rulesCount, instancesCount, onTabChange }: AlertTabsProps) {
  /**
   * Returns CSS classes for a tab button based on active state.
   *
   * @param isActive - Whether this tab is currently active
   * @returns Tailwind CSS class string
   */
  const getTabClasses = (isActive: boolean): string => {
    return isActive
      ? 'bg-dashboard-accent text-dashboard-text'
      : 'text-dashboard-muted hover:text-dashboard-text';
  };

  return (
    <div className="flex gap-4 mb-4">
      <button
        onClick={() => onTabChange('rules')}
        className={`px-4 py-2 rounded-md text-sm font-medium ${getTabClasses(activeTab === 'rules')}`}
      >
        Alert Rules ({rulesCount})
      </button>
      <button
        onClick={() => onTabChange('instances')}
        className={`px-4 py-2 rounded-md text-sm font-medium ${getTabClasses(activeTab === 'instances')}`}
      >
        Alert History ({instancesCount})
      </button>
    </div>
  );
}
