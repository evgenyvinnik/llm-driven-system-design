import { formatCurrency } from '@/utils';

/**
 * Props for the StatsGrid component.
 */
interface StatsGridProps {
  /** Total number of bookings */
  totalBookings: number;
  /** Number of confirmed bookings */
  confirmedBookings: number;
  /** Number of pending (reserved) bookings */
  pendingBookings: number;
  /** Total revenue from confirmed and completed bookings */
  totalRevenue: number;
}

/**
 * Displays a grid of key performance metrics for the hotel.
 * Shows booking counts and revenue in a responsive card layout.
 *
 * @param props - Component props
 * @returns A responsive grid of stat cards
 *
 * @example
 * ```tsx
 * <StatsGrid
 *   totalBookings={100}
 *   confirmedBookings={80}
 *   pendingBookings={15}
 *   totalRevenue={25000}
 * />
 * ```
 */
export function StatsGrid({
  totalBookings,
  confirmedBookings,
  pendingBookings,
  totalRevenue,
}: StatsGridProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <StatCard
        value={totalBookings}
        label="Total Bookings"
        valueClassName="text-gray-900"
      />
      <StatCard
        value={confirmedBookings}
        label="Confirmed"
        valueClassName="text-green-600"
      />
      <StatCard
        value={pendingBookings}
        label="Pending"
        valueClassName="text-yellow-600"
      />
      <StatCard
        value={formatCurrency(totalRevenue)}
        label="Total Revenue"
        valueClassName="text-primary-600"
      />
    </div>
  );
}

/**
 * Props for the StatCard component.
 */
interface StatCardProps {
  /** The value to display (number or formatted string) */
  value: number | string;
  /** Label describing the statistic */
  label: string;
  /** Tailwind classes for the value text color */
  valueClassName: string;
}

/**
 * Individual stat card displaying a single metric.
 */
function StatCard({ value, label, valueClassName }: StatCardProps) {
  return (
    <div className="card p-4 text-center">
      <p className={`text-3xl font-bold ${valueClassName}`}>{value}</p>
      <p className="text-sm text-gray-500">{label}</p>
    </div>
  );
}
