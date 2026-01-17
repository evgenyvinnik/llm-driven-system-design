import { CalendarIcon } from '../icons';

/**
 * Props for the MeetingTypesEmptyState component.
 */
interface MeetingTypesEmptyStateProps {
  /** Callback fired when the create button is clicked */
  onCreateClick: () => void;
}

/**
 * Empty state component displayed when no meeting types exist.
 * Shows a calendar icon, explanatory text, and a call-to-action button.
 *
 * @param props - Component props
 */
export function MeetingTypesEmptyState({ onCreateClick }: MeetingTypesEmptyStateProps) {
  return (
    <div className="card text-center py-12">
      <CalendarIcon className="w-16 h-16 mx-auto mb-4 text-gray-300" />
      <h3 className="text-lg font-medium text-gray-900 mb-2">
        No event types yet
      </h3>
      <p className="text-gray-500 mb-4">
        Create your first event type to start accepting bookings.
      </p>
      <button
        onClick={onCreateClick}
        className="btn btn-primary"
      >
        Create Event Type
      </button>
    </div>
  );
}
