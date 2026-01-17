import { useState, useEffect } from 'react';
import type { AlertInstance, AlertRule } from '../types';
import { getAlertInstances, getAlertRules } from '../services/api';
import { format } from 'date-fns';

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
