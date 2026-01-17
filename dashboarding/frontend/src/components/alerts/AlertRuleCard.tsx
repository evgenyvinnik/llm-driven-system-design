/**
 * @fileoverview Card component for displaying a single alert rule.
 *
 * Shows alert rule details including name, condition, severity,
 * and provides controls for enabling/disabling, testing, and deleting.
 */

import type { AlertRule } from '../../types';
import { getSeverityColor } from './alertUtils';

/**
 * Props for the AlertRuleCard component.
 */
interface AlertRuleCardProps {
  /** The alert rule to display */
  rule: AlertRule;
  /** Callback invoked when toggle enabled/disabled is clicked */
  onToggle: (rule: AlertRule) => void;
  /** Callback invoked when test button is clicked */
  onEvaluate: (id: string) => void;
  /** Callback invoked when delete button is clicked */
  onDelete: (id: string) => void;
}

/**
 * Renders a card displaying alert rule details and actions.
 *
 * Displays:
 * - Severity badge with color coding
 * - Rule name and description
 * - Condition expression (aggregation, metric, operator, threshold, window)
 * - Toggle button for enabled/disabled state
 * - Test and delete action buttons
 *
 * @param props - Component props
 * @returns The rendered alert rule card
 */
export function AlertRuleCard({ rule, onToggle, onEvaluate, onDelete }: AlertRuleCardProps) {
  /**
   * Formats the condition as a human-readable string.
   *
   * @returns Formatted condition string (e.g., "avg(cpu.usage) > 80 over 300s")
   */
  const formatCondition = () => {
    return `${rule.condition.aggregation}(${rule.metric_name}) ${rule.condition.operator} ${rule.condition.threshold} over ${rule.window_seconds}s`;
  };

  return (
    <div className="bg-dashboard-card border border-dashboard-accent rounded-lg p-4">
      <div className="flex items-center justify-between">
        {/* Left side: severity badge and rule info */}
        <div className="flex items-center gap-4">
          <span
            className={`px-2 py-1 rounded text-xs font-medium ${getSeverityColor(rule.severity)}`}
          >
            {rule.severity}
          </span>
          <div>
            <h3 className="font-semibold text-dashboard-text">{rule.name}</h3>
            <p className="text-sm text-dashboard-muted">{formatCondition()}</p>
          </div>
        </div>

        {/* Right side: action buttons */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => onToggle(rule)}
            className={`px-3 py-1 rounded text-sm ${
              rule.enabled ? 'bg-green-600' : 'bg-gray-600'
            }`}
          >
            {rule.enabled ? 'Enabled' : 'Disabled'}
          </button>
          <button
            onClick={() => onEvaluate(rule.id)}
            className="text-dashboard-highlight hover:underline text-sm"
          >
            Test
          </button>
          <button
            onClick={() => onDelete(rule.id)}
            className="text-red-400 hover:text-red-300 text-sm"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
