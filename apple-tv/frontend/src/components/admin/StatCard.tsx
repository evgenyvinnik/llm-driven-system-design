import type { ReactNode } from 'react';

/**
 * Color theme options for stat cards.
 * Each color maps to a gradient and text color combination.
 */
export type StatCardColor = 'blue' | 'purple' | 'green' | 'orange';

/**
 * Props for the StatCard component.
 */
interface StatCardProps {
  /** Icon element to display in the card */
  icon: ReactNode;
  /** Label text describing the metric */
  label: string;
  /** Numeric value to display */
  value: number;
  /** Color theme for the card gradient */
  color: StatCardColor;
}

/**
 * Mapping of color themes to Tailwind CSS gradient and text classes.
 */
const colorClasses: Record<StatCardColor, string> = {
  blue: 'from-blue-500/20 to-blue-600/20 text-blue-400',
  purple: 'from-purple-500/20 to-purple-600/20 text-purple-400',
  green: 'from-green-500/20 to-green-600/20 text-green-400',
  orange: 'from-orange-500/20 to-orange-600/20 text-orange-400',
};

/**
 * Statistic card component for displaying key metrics.
 * Shows an icon, label, and value with a colored gradient background.
 * Used in admin dashboard to display platform statistics at a glance.
 *
 * @example
 * ```tsx
 * <StatCard
 *   icon={<Users className="w-6 h-6" />}
 *   label="Total Users"
 *   value={1500}
 *   color="blue"
 * />
 * ```
 *
 * @param props - StatCardProps with icon, label, value, and color
 * @returns Colored stat card component with gradient background
 */
export function StatCard({ icon, label, value, color }: StatCardProps) {
  return (
    <div className={`bg-gradient-to-br ${colorClasses[color]} rounded-2xl p-6`}>
      <div className="flex items-center gap-4">
        {icon}
        <div>
          <p className="text-sm text-white/60">{label}</p>
          <p className="text-3xl font-bold">{value.toLocaleString()}</p>
        </div>
      </div>
    </div>
  );
}
