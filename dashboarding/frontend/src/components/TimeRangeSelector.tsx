/**
 * @fileoverview Time range selector dropdown component.
 *
 * Provides a dropdown for selecting the time range used by all panels
 * when querying metric data.
 */

import { TIME_RANGE_OPTIONS, TimeRange } from '../types';

/**
 * Props for the TimeRangeSelector component.
 */
interface TimeRangeSelectorProps {
  /** Currently selected time range */
  value: TimeRange;
  /** Callback when a new time range is selected */
  onChange: (range: TimeRange) => void;
}

/**
 * Renders a dropdown for selecting dashboard time range.
 *
 * Displays available time range presets (5m to 7d) and triggers
 * onChange when the user makes a selection. Styled to match the
 * dashboard theme.
 *
 * @param props - Component props
 * @returns The rendered time range selector
 */
export function TimeRangeSelector({ value, onChange }: TimeRangeSelectorProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as TimeRange)}
      className="bg-dashboard-card border border-dashboard-accent rounded-md px-3 py-2 text-sm text-dashboard-text focus:outline-none focus:ring-2 focus:ring-dashboard-highlight"
    >
      {TIME_RANGE_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
