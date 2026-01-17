/**
 * @fileoverview List component for displaying all alert rules.
 *
 * Renders a vertical list of AlertRuleCard components with an empty state
 * when no rules are configured.
 */

import type { AlertRule } from '../../types';
import { AlertRuleCard } from './AlertRuleCard';

/**
 * Props for the AlertRuleList component.
 */
interface AlertRuleListProps {
  /** Array of alert rules to display */
  rules: AlertRule[];
  /** Callback invoked when an alert rule's enabled state is toggled */
  onToggle: (rule: AlertRule) => void;
  /** Callback invoked when test evaluation is requested for a rule */
  onEvaluate: (id: string) => void;
  /** Callback invoked when a rule should be deleted */
  onDelete: (id: string) => void;
}

/**
 * Renders a list of alert rules.
 *
 * Shows an empty state card when no rules exist, otherwise renders
 * each rule as an AlertRuleCard with action handlers.
 *
 * @param props - Component props
 * @returns The rendered alert rule list
 */
export function AlertRuleList({ rules, onToggle, onEvaluate, onDelete }: AlertRuleListProps) {
  if (rules.length === 0) {
    return (
      <div className="bg-dashboard-card border border-dashboard-accent rounded-lg p-8 text-center text-dashboard-muted">
        No alert rules configured
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {rules.map((rule) => (
        <AlertRuleCard
          key={rule.id}
          rule={rule}
          onToggle={onToggle}
          onEvaluate={onEvaluate}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
