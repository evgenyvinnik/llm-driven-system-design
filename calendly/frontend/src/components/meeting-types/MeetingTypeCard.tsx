import { Link } from '@tanstack/react-router';
import type { MeetingType } from '../../types';
import { ActivateIcon, DeactivateIcon, EditIcon, DeleteIcon } from '../icons';

/**
 * Props for the MeetingTypeCard component.
 */
interface MeetingTypeCardProps {
  /** The meeting type data to display */
  meetingType: MeetingType;
  /** Callback fired when the copy link button is clicked */
  onCopyLink: (meetingType: MeetingType) => void;
  /** Callback fired when the toggle active button is clicked */
  onToggleActive: (meetingType: MeetingType) => void;
  /** Callback fired when the edit button is clicked */
  onEdit: (meetingType: MeetingType) => void;
  /** Callback fired when the delete button is clicked */
  onDelete: (id: string) => void;
}

/**
 * Renders a single meeting type as a card.
 * Displays meeting type information including name, duration, description,
 * and provides action buttons for copy link, toggle active, edit, and delete.
 *
 * @param props - Component props
 */
export function MeetingTypeCard({
  meetingType,
  onCopyLink,
  onToggleActive,
  onEdit,
  onDelete,
}: MeetingTypeCardProps) {
  return (
    <div
      className={`card border-t-4 ${meetingType.is_active ? '' : 'opacity-60'}`}
      style={{ borderTopColor: meetingType.color }}
    >
      <MeetingTypeCardHeader meetingType={meetingType} />

      {meetingType.description && (
        <p className="text-sm text-gray-600 mb-4 line-clamp-2">
          {meetingType.description}
        </p>
      )}

      <MeetingTypeCardActions
        meetingType={meetingType}
        onCopyLink={onCopyLink}
        onToggleActive={onToggleActive}
        onEdit={onEdit}
        onDelete={onDelete}
      />

      <Link
        to="/book/$meetingTypeId"
        params={{ meetingTypeId: meetingType.id }}
        className="block mt-4 text-center btn btn-secondary text-sm"
      >
        Preview Booking Page
      </Link>
    </div>
  );
}

/**
 * Props for the MeetingTypeCardHeader component.
 */
interface MeetingTypeCardHeaderProps {
  /** The meeting type data */
  meetingType: MeetingType;
}

/**
 * Renders the header section of a meeting type card.
 * Shows name, duration, and active status badge.
 *
 * @param props - Component props
 */
function MeetingTypeCardHeader({ meetingType }: MeetingTypeCardHeaderProps) {
  return (
    <div className="flex items-start justify-between mb-4">
      <div>
        <h3 className="text-lg font-semibold text-gray-900">{meetingType.name}</h3>
        <p className="text-sm text-gray-500">{meetingType.duration_minutes} min</p>
      </div>
      <span
        className={`px-2 py-1 text-xs rounded-full ${
          meetingType.is_active
            ? 'bg-green-100 text-green-800'
            : 'bg-gray-100 text-gray-600'
        }`}
      >
        {meetingType.is_active ? 'Active' : 'Inactive'}
      </span>
    </div>
  );
}

/**
 * Props for the MeetingTypeCardActions component.
 */
interface MeetingTypeCardActionsProps {
  /** The meeting type data */
  meetingType: MeetingType;
  /** Callback fired when the copy link button is clicked */
  onCopyLink: (meetingType: MeetingType) => void;
  /** Callback fired when the toggle active button is clicked */
  onToggleActive: (meetingType: MeetingType) => void;
  /** Callback fired when the edit button is clicked */
  onEdit: (meetingType: MeetingType) => void;
  /** Callback fired when the delete button is clicked */
  onDelete: (id: string) => void;
}

/**
 * Renders the action buttons for a meeting type card.
 * Includes copy link, toggle active, edit, and delete buttons.
 *
 * @param props - Component props
 */
function MeetingTypeCardActions({
  meetingType,
  onCopyLink,
  onToggleActive,
  onEdit,
  onDelete,
}: MeetingTypeCardActionsProps) {
  return (
    <div className="flex items-center justify-between pt-4 border-t border-gray-100">
      <button
        onClick={() => onCopyLink(meetingType)}
        className="text-primary-600 hover:text-primary-700 text-sm font-medium"
      >
        Copy Link
      </button>
      <div className="flex items-center space-x-2">
        <button
          onClick={() => onToggleActive(meetingType)}
          className="p-2 text-gray-400 hover:text-gray-600"
          title={meetingType.is_active ? 'Deactivate' : 'Activate'}
        >
          {meetingType.is_active ? <DeactivateIcon /> : <ActivateIcon />}
        </button>
        <button
          onClick={() => onEdit(meetingType)}
          className="p-2 text-gray-400 hover:text-gray-600"
          title="Edit"
        >
          <EditIcon />
        </button>
        <button
          onClick={() => onDelete(meetingType.id)}
          className="p-2 text-gray-400 hover:text-red-600"
          title="Delete"
        >
          <DeleteIcon />
        </button>
      </div>
    </div>
  );
}
