/**
 * @fileoverview Table component for displaying alert history.
 *
 * Shows a table of alert instances with their status, associated rule,
 * value at trigger time, and timestamps for firing and resolution.
 */

import { format } from 'date-fns';
import type { AlertInstance, AlertRule } from '../../types';
import { getStatusColor } from './alertUtils';

/**
 * Props for the AlertHistoryTable component.
 */
interface AlertHistoryTableProps {
  /** Array of alert instances to display */
  instances: AlertInstance[];
  /** Map of rule IDs to rule objects for name lookup */
  rules: AlertRule[];
}

/**
 * Renders a table displaying alert history (firing and resolved alerts).
 *
 * Table columns:
 * - Status: firing (red) or resolved (green)
 * - Rule: name of the associated alert rule
 * - Value: metric value when alert was triggered
 * - Fired At: timestamp when alert started firing
 * - Resolved At: timestamp when alert was resolved (or '-' if still firing)
 *
 * Shows an empty state message when there are no alert instances.
 *
 * @param props - Component props
 * @returns The rendered alert history table
 */
export function AlertHistoryTable({ instances, rules }: AlertHistoryTableProps) {
  /**
   * Finds the rule name for a given rule ID.
   *
   * @param ruleId - The UUID of the alert rule
   * @returns The rule name or the rule ID if not found
   */
  const getRuleName = (ruleId: string): string => {
    const rule = rules.find((r) => r.id === ruleId);
    return rule?.name || ruleId;
  };

  /**
   * Formats a timestamp for display.
   *
   * @param timestamp - ISO timestamp string
   * @returns Formatted date-time string
   */
  const formatTimestamp = (timestamp: string): string => {
    return format(new Date(timestamp), 'yyyy-MM-dd HH:mm:ss');
  };

  return (
    <div className="bg-dashboard-card border border-dashboard-accent rounded-lg overflow-hidden">
      <table className="w-full">
        <thead className="bg-dashboard-accent">
          <tr>
            <th className="px-4 py-2 text-left text-sm text-dashboard-muted">Status</th>
            <th className="px-4 py-2 text-left text-sm text-dashboard-muted">Rule</th>
            <th className="px-4 py-2 text-left text-sm text-dashboard-muted">Value</th>
            <th className="px-4 py-2 text-left text-sm text-dashboard-muted">Fired At</th>
            <th className="px-4 py-2 text-left text-sm text-dashboard-muted">Resolved At</th>
          </tr>
        </thead>
        <tbody>
          {instances.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-dashboard-muted">
                No alert history
              </td>
            </tr>
          ) : (
            instances.map((instance) => (
              <tr key={instance.id} className="border-t border-dashboard-accent">
                <td className={`px-4 py-2 font-medium ${getStatusColor(instance.status)}`}>
                  {instance.status}
                </td>
                <td className="px-4 py-2 text-dashboard-text">
                  {getRuleName(instance.rule_id)}
                </td>
                <td className="px-4 py-2 text-dashboard-text">
                  {instance.value.toFixed(2)}
                </td>
                <td className="px-4 py-2 text-dashboard-muted">
                  {formatTimestamp(instance.fired_at)}
                </td>
                <td className="px-4 py-2 text-dashboard-muted">
                  {instance.resolved_at ? formatTimestamp(instance.resolved_at) : '-'}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
