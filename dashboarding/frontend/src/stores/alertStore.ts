/**
 * @fileoverview Zustand store for alert state management.
 *
 * Manages alert rules, instances, and firing alerts for the alerts UI.
 * Provides centralized state with loading/error handling.
 */

import { create } from 'zustand';
import type { AlertRule, AlertInstance } from '../types';

/**
 * Alert store state and actions interface.
 */
interface AlertState {
  /** All loaded alert rules */
  alertRules: AlertRule[];
  /** All alert instances (firing and historical) */
  alertInstances: AlertInstance[];
  /** Currently firing alerts (filtered from instances) */
  firingAlerts: AlertInstance[];
  /** Whether alert data is currently being fetched */
  isLoading: boolean;
  /** Error message from last failed operation */
  error: string | null;

  /**
   * Sets the alert rules array.
   * @param rules - Alert rules to store
   */
  setAlertRules: (rules: AlertRule[]) => void;

  /**
   * Sets all alert instances.
   * @param instances - Alert instances to store
   */
  setAlertInstances: (instances: AlertInstance[]) => void;

  /**
   * Sets the currently firing alerts.
   * @param alerts - Firing alert instances
   */
  setFiringAlerts: (alerts: AlertInstance[]) => void;

  /**
   * Sets the loading state.
   * @param loading - Whether a fetch operation is in progress
   */
  setLoading: (loading: boolean) => void;

  /**
   * Sets the error state.
   * @param error - Error message or null to clear
   */
  setError: (error: string | null) => void;
}

/**
 * Zustand store for alert state.
 *
 * Provides centralized alert data with loading/error states.
 */
export const useAlertStore = create<AlertState>((set) => ({
  alertRules: [],
  alertInstances: [],
  firingAlerts: [],
  isLoading: false,
  error: null,
  setAlertRules: (alertRules) => set({ alertRules }),
  setAlertInstances: (alertInstances) => set({ alertInstances }),
  setFiringAlerts: (firingAlerts) => set({ firingAlerts }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
}));
