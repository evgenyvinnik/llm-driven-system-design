/**
 * @fileoverview Custom hook for managing alert data fetching and state.
 *
 * Provides centralized data fetching, caching, and CRUD operations for
 * alert rules and instances. Handles polling for real-time updates.
 */

import { useState, useEffect, useCallback } from 'react';
import type { AlertRule, AlertInstance } from '../types';
import {
  getAlertRules,
  getAlertInstances,
  createAlertRule,
  deleteAlertRule,
  updateAlertRule,
  evaluateAlertRule,
} from '../services/api';
import type { AlertRuleFormData } from '../components/alerts';

/**
 * Polling interval for fetching alerts (30 seconds).
 */
const POLL_INTERVAL_MS = 30000;

/**
 * Return type for the useAlerts hook.
 */
interface UseAlertsReturn {
  /** Array of alert rules */
  rules: AlertRule[];
  /** Array of alert instances (history) */
  instances: AlertInstance[];
  /** Whether data is currently loading */
  loading: boolean;
  /** Error message if an operation failed */
  error: string | null;
  /** Clears the current error message */
  clearError: () => void;
  /** Refetches all data */
  refresh: () => Promise<void>;
  /** Creates a new alert rule */
  createRule: (data: AlertRuleFormData) => Promise<void>;
  /** Deletes an alert rule by ID */
  deleteRule: (id: string) => Promise<void>;
  /** Toggles the enabled state of an alert rule */
  toggleRule: (rule: AlertRule) => Promise<void>;
  /** Manually evaluates an alert rule and shows result */
  evaluateRule: (id: string) => Promise<void>;
}

/**
 * Custom hook for managing alert rules and instances.
 *
 * Features:
 * - Fetches rules and instances on mount
 * - Polls for updates every 30 seconds
 * - Provides CRUD operations for alert rules
 * - Handles loading and error states
 * - Supports manual rule evaluation
 *
 * @returns Object containing alert data and operations
 *
 * @example
 * ```tsx
 * function AlertsPage() {
 *   const { rules, instances, loading, error, createRule, deleteRule } = useAlerts();
 *
 *   if (loading) return <Spinner />;
 *   if (error) return <ErrorMessage message={error} />;
 *
 *   return <AlertRuleList rules={rules} onDelete={deleteRule} />;
 * }
 * ```
 */
export function useAlerts(): UseAlertsReturn {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [instances, setInstances] = useState<AlertInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Fetches alert rules and instances from the API.
   * Updates state with results or sets error on failure.
   */
  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [rulesData, instancesData] = await Promise.all([
        getAlertRules(),
        getAlertInstances({ limit: 50 }),
      ]);
      setRules(rulesData);
      setInstances(instancesData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch alerts');
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Clears the current error message.
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  /**
   * Creates a new alert rule from form data.
   *
   * @param data - Form data containing rule configuration
   */
  const createRule = useCallback(async (data: AlertRuleFormData) => {
    try {
      await createAlertRule({
        name: data.name,
        description: data.description || null,
        metric_name: data.metric_name,
        tags: {},
        condition: {
          operator: data.condition_operator,
          threshold: data.condition_threshold,
          aggregation: data.condition_aggregation,
        },
        window_seconds: data.window_seconds,
        severity: data.severity,
        notifications: [{ channel: 'console', target: 'default' }],
        enabled: true,
      });
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create alert');
      throw err;
    }
  }, [fetchData]);

  /**
   * Deletes an alert rule after user confirmation.
   *
   * @param id - UUID of the rule to delete
   */
  const deleteRule = useCallback(async (id: string) => {
    if (!confirm('Delete this alert rule?')) return;
    try {
      await deleteAlertRule(id);
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete alert');
    }
  }, [fetchData]);

  /**
   * Toggles the enabled state of an alert rule.
   *
   * @param rule - The rule to toggle
   */
  const toggleRule = useCallback(async (rule: AlertRule) => {
    try {
      await updateAlertRule(rule.id, { enabled: !rule.enabled });
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update alert');
    }
  }, [fetchData]);

  /**
   * Manually evaluates an alert rule and displays the result.
   *
   * @param id - UUID of the rule to evaluate
   */
  const evaluateRule = useCallback(async (id: string) => {
    try {
      const result = await evaluateAlertRule(id);
      alert(
        `Evaluation result:\nShould fire: ${result.should_fire}\nCurrent value: ${result.current_value?.toFixed(2) ?? 'N/A'}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to evaluate alert');
    }
  }, []);

  // Initial fetch and polling setup
  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  return {
    rules,
    instances,
    loading,
    error,
    clearError,
    refresh: fetchData,
    createRule,
    deleteRule,
    toggleRule,
    evaluateRule,
  };
}
