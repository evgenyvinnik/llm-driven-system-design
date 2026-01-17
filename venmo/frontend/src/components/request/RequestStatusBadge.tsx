/**
 * RequestStatusBadge component for displaying request status.
 */

/**
 * Props for the RequestStatusBadge component.
 */
interface RequestStatusBadgeProps {
  /** The status of the request */
  status: 'pending' | 'paid' | 'declined' | 'cancelled';
}

/**
 * Renders a colored badge indicating the request status.
 */
export function RequestStatusBadge({ status }: RequestStatusBadgeProps) {
  const getStatusClasses = () => {
    switch (status) {
      case 'paid':
        return 'bg-green-100 text-green-700';
      case 'declined':
        return 'bg-red-100 text-red-700';
      default:
        return 'bg-gray-100 text-gray-700';
    }
  };

  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${getStatusClasses()}`}>
      {status}
    </span>
  );
}
