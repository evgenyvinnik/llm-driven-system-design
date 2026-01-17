import { create } from 'zustand';
import type { AlertRule, AlertInstance } from '../types';

interface AlertState {
  alertRules: AlertRule[];
  alertInstances: AlertInstance[];
  firingAlerts: AlertInstance[];
  isLoading: boolean;
  error: string | null;
  setAlertRules: (rules: AlertRule[]) => void;
  setAlertInstances: (instances: AlertInstance[]) => void;
  setFiringAlerts: (alerts: AlertInstance[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

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
