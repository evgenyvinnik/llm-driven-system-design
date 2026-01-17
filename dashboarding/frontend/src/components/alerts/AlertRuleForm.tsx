/**
 * @fileoverview Form component for creating new alert rules.
 *
 * Provides a form interface for configuring alert rule parameters including
 * name, metric, conditions, severity, and evaluation window.
 */

import { useState } from 'react';

/**
 * Form data structure for alert rule creation.
 */
export interface AlertRuleFormData {
  name: string;
  description: string;
  metric_name: string;
  condition_operator: '>' | '<' | '>=' | '<=';
  condition_threshold: number;
  condition_aggregation: 'avg' | 'min' | 'max' | 'sum';
  window_seconds: number;
  severity: 'info' | 'warning' | 'critical';
}

/**
 * Initial/default form values.
 */
const DEFAULT_FORM_DATA: AlertRuleFormData = {
  name: '',
  description: '',
  metric_name: '',
  condition_operator: '>',
  condition_threshold: 80,
  condition_aggregation: 'avg',
  window_seconds: 300,
  severity: 'warning',
};

/**
 * Props for the AlertRuleForm component.
 */
interface AlertRuleFormProps {
  /** Callback invoked when form is submitted with valid data */
  onSubmit: (data: AlertRuleFormData) => Promise<void>;
  /** Callback invoked when form is cancelled */
  onCancel: () => void;
}

/**
 * Renders a form for creating new alert rules.
 *
 * Features:
 * - Input fields for name, metric, description
 * - Condition configuration (aggregation, operator, threshold)
 * - Severity and evaluation window selectors
 * - Validation: requires name and metric_name
 *
 * @param props - Component props
 * @returns The rendered form
 */
export function AlertRuleForm({ onSubmit, onCancel }: AlertRuleFormProps) {
  const [formData, setFormData] = useState<AlertRuleFormData>(DEFAULT_FORM_DATA);
  const [isSubmitting, setIsSubmitting] = useState(false);

  /**
   * Handles form submission.
   * Validates required fields and invokes onSubmit callback.
   */
  const handleSubmit = async () => {
    if (!formData.name || !formData.metric_name) return;

    setIsSubmitting(true);
    try {
      await onSubmit(formData);
      setFormData(DEFAULT_FORM_DATA);
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * Updates a single field in the form data.
   *
   * @param field - Field name to update
   * @param value - New value for the field
   */
  const updateField = <K extends keyof AlertRuleFormData>(
    field: K,
    value: AlertRuleFormData[K]
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const isValid = formData.name.trim() !== '' && formData.metric_name.trim() !== '';

  return (
    <div className="bg-dashboard-card border border-dashboard-accent rounded-lg p-4 mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-dashboard-text">Create Alert Rule</h2>
        <button
          onClick={onCancel}
          className="text-dashboard-muted hover:text-dashboard-text text-sm"
        >
          Cancel
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Name field */}
        <div>
          <label className="block text-sm text-dashboard-muted mb-1">Name</label>
          <input
            type="text"
            value={formData.name}
            onChange={(e) => updateField('name', e.target.value)}
            className="w-full bg-dashboard-bg border border-dashboard-accent rounded-md px-3 py-2 text-dashboard-text"
            placeholder="High CPU Alert"
          />
        </div>

        {/* Metric name field */}
        <div>
          <label className="block text-sm text-dashboard-muted mb-1">Metric Name</label>
          <input
            type="text"
            value={formData.metric_name}
            onChange={(e) => updateField('metric_name', e.target.value)}
            className="w-full bg-dashboard-bg border border-dashboard-accent rounded-md px-3 py-2 text-dashboard-text"
            placeholder="cpu.usage"
          />
        </div>

        {/* Condition configuration */}
        <div>
          <label className="block text-sm text-dashboard-muted mb-1">Condition</label>
          <div className="flex gap-2">
            <select
              value={formData.condition_aggregation}
              onChange={(e) =>
                updateField('condition_aggregation', e.target.value as AlertRuleFormData['condition_aggregation'])
              }
              className="bg-dashboard-bg border border-dashboard-accent rounded-md px-2 py-2 text-dashboard-text"
            >
              <option value="avg">avg</option>
              <option value="min">min</option>
              <option value="max">max</option>
              <option value="sum">sum</option>
            </select>
            <select
              value={formData.condition_operator}
              onChange={(e) =>
                updateField('condition_operator', e.target.value as AlertRuleFormData['condition_operator'])
              }
              className="bg-dashboard-bg border border-dashboard-accent rounded-md px-2 py-2 text-dashboard-text"
            >
              <option value=">">&gt;</option>
              <option value="<">&lt;</option>
              <option value=">=">&gt;=</option>
              <option value="<=">&lt;=</option>
            </select>
            <input
              type="number"
              value={formData.condition_threshold}
              onChange={(e) => updateField('condition_threshold', parseFloat(e.target.value) || 0)}
              className="w-24 bg-dashboard-bg border border-dashboard-accent rounded-md px-2 py-2 text-dashboard-text"
            />
          </div>
        </div>

        {/* Severity selector */}
        <div>
          <label className="block text-sm text-dashboard-muted mb-1">Severity</label>
          <select
            value={formData.severity}
            onChange={(e) =>
              updateField('severity', e.target.value as AlertRuleFormData['severity'])
            }
            className="w-full bg-dashboard-bg border border-dashboard-accent rounded-md px-3 py-2 text-dashboard-text"
          >
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </div>

        {/* Window seconds field */}
        <div>
          <label className="block text-sm text-dashboard-muted mb-1">Window (seconds)</label>
          <input
            type="number"
            value={formData.window_seconds}
            onChange={(e) => updateField('window_seconds', parseInt(e.target.value) || 0)}
            className="w-full bg-dashboard-bg border border-dashboard-accent rounded-md px-3 py-2 text-dashboard-text"
          />
        </div>

        {/* Description field (full width) */}
        <div className="col-span-2">
          <label className="block text-sm text-dashboard-muted mb-1">Description</label>
          <input
            type="text"
            value={formData.description}
            onChange={(e) => updateField('description', e.target.value)}
            className="w-full bg-dashboard-bg border border-dashboard-accent rounded-md px-3 py-2 text-dashboard-text"
            placeholder="Optional description"
          />
        </div>
      </div>

      {/* Submit button */}
      <button
        onClick={handleSubmit}
        disabled={!isValid || isSubmitting}
        className="mt-4 bg-dashboard-highlight hover:bg-dashboard-highlight/80 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-md text-sm font-medium"
      >
        {isSubmitting ? 'Creating...' : 'Create Alert Rule'}
      </button>
    </div>
  );
}
