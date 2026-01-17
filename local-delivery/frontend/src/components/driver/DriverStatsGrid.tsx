import type { DriverStats } from '@/types';

/**
 * Props for the DriverStatsGrid component.
 */
interface DriverStatsGridProps {
  /** Driver statistics including current orders, acceptance rate, and total deliveries */
  stats: DriverStats;
}

/**
 * Individual stat card component for displaying a single metric.
 */
interface StatCardProps {
  /** The numeric or string value to display prominently */
  value: string | number;
  /** Label describing what the value represents */
  label: string;
}

/**
 * Renders a single stat card with a value and label.
 */
function StatCard({ value, label }: StatCardProps) {
  return (
    <div className="card p-4 text-center">
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      <p className="text-sm text-gray-500">{label}</p>
    </div>
  );
}

/**
 * Displays a grid of driver statistics including active orders,
 * acceptance rate percentage, and total lifetime deliveries.
 *
 * @example
 * ```tsx
 * <DriverStatsGrid
 *   stats={{
 *     current_orders: 2,
 *     acceptance_rate: 0.95,
 *     total_deliveries: 150,
 *     rating: 4.8
 *   }}
 * />
 * ```
 */
export function DriverStatsGrid({ stats }: DriverStatsGridProps) {
  /**
   * Formats the acceptance rate as a percentage string.
   * Defaults to 100% if the rate is not provided.
   */
  const formatAcceptanceRate = (): string => {
    const rate = stats.acceptance_rate ?? 1;
    return `${(rate * 100).toFixed(0)}%`;
  };

  return (
    <div className="grid grid-cols-3 gap-4 mb-6">
      <StatCard
        value={stats.current_orders ?? 0}
        label="Active Orders"
      />
      <StatCard
        value={formatAcceptanceRate()}
        label="Acceptance Rate"
      />
      <StatCard
        value={stats.total_deliveries}
        label="Total Deliveries"
      />
    </div>
  );
}
