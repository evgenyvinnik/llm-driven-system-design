/**
 * @fileoverview Alert banner component for displaying active alerts.
 *
 * Shows a horizontal banner at the top of the page when there are
 * firing alerts. Provides quick visibility into critical system issues.
 */

import { useState, useEffect } from 'react';
import type { AlertInstance, AlertRule } from '../types';
import { getAlertInstances, getAlertRules } from '../services/api';
import { format } from 'date-fns';

/**
 * Renders a banner displaying currently firing alerts.
 *
 * Fetches firing alerts and their associated rules every 30 seconds.
 * Displays each alert as a colored pill with severity, name, value,
 * and time. Returns null if there are no active alerts.
 *
 * @returns The rendered alert banner or null
 */
export function AlertBanner() {
  const [firingAlerts, setFiringAlerts] = useState<AlertInstance[]>([]);
  const [rules, setRules] = useState<Map<string, AlertRule>>(new Map());

  const fetchAlerts = async () => {
    try {
      const [instances, allRules] = await Promise.all([
        getAlertInstances({ status: 'firing', limit: 10 }),
        getAlertRules(),
      ]);
      setFiringAlerts(instances);
      setRules(new Map(allRules.map((r) => [r.id, r])));
    } catch (error) {
      console.error('Failed to fetch alerts:', error);
    }
  };

  useEffect(() => {
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 30000);
    return () => clearInterval(interval);
  }, []);

  if (firingAlerts.length === 0) {
    return null;
  }

  /**
   * Returns the appropriate CSS class for an alert severity level.
   *
   * @param severity - The alert severity ('critical', 'warning', 'info')
   * @returns Tailwind CSS class for the severity color
   */
  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'bg-red-600';
      case 'warning':
        return 'bg-yellow-600';
      default:
        return 'bg-blue-600';
    }
  };

  return (
    <div className="bg-red-900/50 border-b border-red-700 px-4 py-2">
      <div className="flex items-center gap-4 overflow-x-auto">
        <span className="text-red-400 font-semibold whitespace-nowrap">
          Active Alerts ({firingAlerts.length})
        </span>
        {firingAlerts.map((alert) => {
          const rule = rules.get(alert.rule_id);
          return (
            <div
              key={alert.id}
              className={`flex items-center gap-2 px-3 py-1 rounded-full text-sm ${getSeverityColor(rule?.severity || 'info')}`}
            >
              <span className="font-medium">{rule?.name || 'Unknown'}</span>
              <span className="text-white/70">
                {alert.value.toFixed(2)} @ {format(new Date(alert.fired_at), 'HH:mm')}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
