/**
 * StatCard - A simple statistics display card.
 * Used to show numeric metrics with labels in a compact format.
 *
 * @param label - The descriptive label for the statistic
 * @param value - The formatted value to display (already converted to string)
 */
interface StatCardProps {
  label: string;
  value: string;
}

export function StatCard({ label, value }: StatCardProps) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
    </div>
  );
}
