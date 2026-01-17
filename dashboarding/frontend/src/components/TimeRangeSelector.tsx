import { TIME_RANGE_OPTIONS, TimeRange } from '../types';

interface TimeRangeSelectorProps {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
}

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
