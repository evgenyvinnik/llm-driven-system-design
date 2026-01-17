/**
 * @fileoverview Statistics card component for displaying metrics.
 *
 * A reusable card component for displaying a single statistic with:
 * - Title describing the metric
 * - Large formatted value (with K/M abbreviations for large numbers)
 * - Optional subtitle for additional context
 * - Optional icon
 * - Configurable color theme
 *
 * @module components/StatCard
 */

/**
 * Props for the StatCard component.
 */
interface StatCardProps {
  /** Title/label for the statistic */
  title: string;
  /** The value to display (numbers are auto-formatted) */
  value: string | number;
  /** Optional subtitle for additional context */
  subtitle?: string;
  /** Optional icon to display */
  icon?: React.ReactNode;
  /** Color theme for the card (default: 'blue') */
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'gray';
}

/**
 * Tailwind CSS classes for each color theme.
 */
const colorClasses = {
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  green: 'bg-green-50 text-green-700 border-green-200',
  yellow: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  red: 'bg-red-50 text-red-700 border-red-200',
  purple: 'bg-purple-50 text-purple-700 border-purple-200',
  gray: 'bg-gray-50 text-gray-700 border-gray-200',
};

/**
 * A card component for displaying a single statistic.
 *
 * Automatically formats large numbers with K (thousands) or M (millions) suffixes.
 * Provides consistent styling across the dashboard for all metrics.
 *
 * @param props - Component props
 * @returns React component rendering the stat card
 *
 * @example
 * ```tsx
 * <StatCard
 *   title="Pages Crawled"
 *   value={1234567}
 *   color="green"
 * />
 * // Displays: "1.2M"
 *
 * <StatCard
 *   title="Pending URLs"
 *   value={5000}
 *   subtitle="in queue"
 *   color="yellow"
 * />
 * // Displays: "5.0K" with "in queue" subtitle
 * ```
 */
export function StatCard({ title, value, subtitle, icon, color = 'blue' }: StatCardProps) {
  /**
   * Formats a numeric value with K/M suffix for readability.
   * - Values >= 1M show as "X.XM"
   * - Values >= 1K show as "X.XK"
   * - Smaller values show with locale formatting
   */
  const formattedValue =
    typeof value === 'number'
      ? value >= 1_000_000
        ? `${(value / 1_000_000).toFixed(1)}M`
        : value >= 1_000
          ? `${(value / 1_000).toFixed(1)}K`
          : value.toLocaleString()
      : value;

  return (
    <div className={`rounded-lg border p-4 ${colorClasses[color]}`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium opacity-80">{title}</p>
          <p className="mt-1 text-2xl font-semibold">{formattedValue}</p>
          {subtitle && <p className="mt-1 text-xs opacity-60">{subtitle}</p>}
        </div>
        {icon && <div className="opacity-50">{icon}</div>}
      </div>
    </div>
  );
}
