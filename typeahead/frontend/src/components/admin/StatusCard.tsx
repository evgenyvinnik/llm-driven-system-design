/**
 * StatusCard - A card displaying system service status with an icon.
 * Used to show the health status of individual services like Redis, PostgreSQL.
 *
 * @param title - The service name displayed as the card header
 * @param value - The current status value (e.g., "connected", "healthy")
 * @param status - The status type that determines the card's color scheme
 * @param icon - React node containing the icon to display
 */
interface StatusCardProps {
  title: string;
  value: string;
  status: 'success' | 'warning' | 'error';
  icon: React.ReactNode;
}

/** Maps status types to their corresponding Tailwind CSS classes */
const STATUS_COLORS = {
  success: 'bg-green-50 text-green-600',
  warning: 'bg-yellow-50 text-yellow-600',
  error: 'bg-red-50 text-red-600',
} as const;

export function StatusCard({ title, value, status, icon }: StatusCardProps) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center gap-4">
        <div className={`p-3 rounded-lg ${STATUS_COLORS[status]}`}>{icon}</div>
        <div>
          <p className="text-sm text-gray-500">{title}</p>
          <p className="text-lg font-semibold text-gray-900 capitalize">{value}</p>
        </div>
      </div>
    </div>
  );
}
