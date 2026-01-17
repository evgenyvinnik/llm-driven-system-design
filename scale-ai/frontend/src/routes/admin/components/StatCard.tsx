/**
 * StatCard component - Displays a single statistic with title and value.
 * Used in the admin dashboard overview to show key metrics like
 * total drawings, users, flagged items, and active model.
 * @module routes/admin/components/StatCard
 */

/**
 * Props for the StatCard component.
 */
interface StatCardProps {
  /** Label for the statistic */
  title: string
  /** The statistic value (can be number or string) */
  value: string | number
  /** Optional secondary text (e.g., "10 today" or "95% accuracy") */
  subtitle?: string
  /** Color theme for the card */
  color: 'blue' | 'green' | 'red' | 'purple'
}

/**
 * A card component displaying a single statistic with visual styling.
 * Supports four color themes and an optional subtitle for context.
 *
 * @param props - Component props
 * @param props.title - Label for the statistic
 * @param props.value - The statistic value
 * @param props.subtitle - Optional secondary text
 * @param props.color - Color theme (blue, green, red, purple)
 */
export function StatCard({ title, value, subtitle, color }: StatCardProps) {
  return (
    <div className={`stat-card card ${color}`}>
      <h3>{title}</h3>
      <div className="stat-value">{value}</div>
      {subtitle && <div className="stat-subtitle">{subtitle}</div>}
    </div>
  )
}
