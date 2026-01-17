/**
 * @fileoverview Statistics card component for the admin dashboard.
 * Displays a metric with an icon and color-coded styling.
 */

import { ChevronRight } from 'lucide-react';

/**
 * Available color themes for stat cards.
 */
export type StatCardColor = 'blue' | 'green' | 'orange' | 'purple' | 'teal' | 'indigo';

/**
 * Props for the StatCard component.
 */
interface StatCardProps {
  /** Icon component to display */
  icon: React.ComponentType<{ className?: string }>;
  /** Label describing the metric */
  label: string;
  /** Metric value (number or formatted string) */
  value: number | string;
  /** Color theme for the card */
  color: StatCardColor;
}

/**
 * Color class mappings for each theme.
 */
const colorClasses: Record<StatCardColor, string> = {
  blue: 'bg-blue-50 text-blue-600',
  green: 'bg-green-50 text-green-600',
  orange: 'bg-orange-50 text-orange-600',
  purple: 'bg-purple-50 text-purple-600',
  teal: 'bg-teal-50 text-teal-600',
  indigo: 'bg-indigo-50 text-indigo-600',
};

/**
 * Renders a statistics card with icon, label, and value.
 * Used in the admin dashboard overview to display key metrics.
 *
 * @param props - StatCard props
 * @returns Styled card displaying a single metric
 */
export function StatCard({ icon: Icon, label, value, color }: StatCardProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <div className="flex items-center gap-4">
        <div className={`p-3 rounded-lg ${colorClasses[color]}`}>
          <Icon className="w-6 h-6" />
        </div>
        <div>
          <p className="text-sm text-gray-500">{label}</p>
          <p className="text-2xl font-bold text-gray-900">
            {typeof value === 'number' ? value.toLocaleString() : value}
          </p>
        </div>
        <ChevronRight className="w-5 h-5 text-gray-400 ml-auto" />
      </div>
    </div>
  );
}
