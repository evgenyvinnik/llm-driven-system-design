import React from 'react';

/**
 * Color theme options for the StatCard component.
 */
export type StatCardColor = 'blue' | 'green' | 'yellow' | 'red' | 'purple';

/**
 * Props for the StatCard component.
 */
export interface StatCardProps {
  /** Title label for the statistic */
  title: string;
  /** Value to display (number or formatted string) */
  value: string | number;
  /** Optional subtitle for additional context */
  subtitle?: string;
  /** Color theme for the card (defaults to 'blue') */
  color?: StatCardColor;
}

/**
 * Color class mappings for each theme.
 */
const colorClasses: Record<StatCardColor, string> = {
  blue: 'bg-blue-100 text-blue-800',
  green: 'bg-green-100 text-green-800',
  yellow: 'bg-yellow-100 text-yellow-800',
  red: 'bg-red-100 text-red-800',
  purple: 'bg-purple-100 text-purple-800',
};

/**
 * Displays a single statistic in a colored card.
 *
 * Used in the admin dashboard to show key metrics with
 * color-coded backgrounds for quick visual scanning.
 *
 * @example
 * ```tsx
 * <StatCard title="Total Users" value={1234} color="blue" />
 * <StatCard
 *   title="Storage Used"
 *   value="4.5 GB"
 *   subtitle="of 10 GB"
 *   color="purple"
 * />
 * ```
 *
 * @param props - Component props
 * @returns Styled statistic card element
 */
export const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  subtitle,
  color = 'blue',
}) => {
  return (
    <div className={`p-4 rounded-lg ${colorClasses[color]}`}>
      <h3 className="text-sm font-medium opacity-75">{title}</h3>
      <p className="text-2xl font-bold mt-1">{value}</p>
      {subtitle && <p className="text-xs opacity-75 mt-1">{subtitle}</p>}
    </div>
  );
};
