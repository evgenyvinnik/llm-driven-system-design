/**
 * Status badge component for displaying envelope and recipient statuses.
 * Applies appropriate color styling based on the status value.
 *
 * @param props - Component props
 * @param props.status - The status string to display (e.g., 'draft', 'completed', 'pending')
 * @returns A styled span element showing the capitalized status
 */
interface StatusBadgeProps {
  /** The status value to display */
  status: string;
}

/** Color mappings for different status values */
const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-800',
  sent: 'bg-blue-100 text-blue-800',
  delivered: 'bg-blue-100 text-blue-800',
  pending: 'bg-yellow-100 text-yellow-800',
  signed: 'bg-yellow-100 text-yellow-800',
  completed: 'bg-green-100 text-green-800',
  declined: 'bg-red-100 text-red-800',
  voided: 'bg-gray-100 text-gray-800',
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const colorClass = STATUS_COLORS[status] || 'bg-gray-100 text-gray-800';
  const displayText = status.charAt(0).toUpperCase() + status.slice(1);

  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${colorClass}`}>
      {displayText}
    </span>
  );
}
