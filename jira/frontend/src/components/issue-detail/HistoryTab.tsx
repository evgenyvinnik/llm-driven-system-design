import { formatDistanceToNow } from 'date-fns';
import type { IssueHistory } from '../../types';
import { Avatar } from '../ui';

/**
 * Props for the HistoryTab component.
 */
interface HistoryTabProps {
  /** List of history entries to display */
  history: IssueHistory[];
}

/**
 * History tab content component.
 *
 * Displays a chronological list of changes made to the issue.
 * Each entry shows who made the change, what field changed,
 * old/new values, and when it happened.
 *
 * @param props - The component props
 * @returns The rendered history tab
 */
export function HistoryTab({ history }: HistoryTabProps) {
  return (
    <div className="space-y-3">
      {history.map((entry) => (
        <HistoryItem key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

/**
 * Individual history entry display component.
 *
 * Displays a single history entry showing the user, field changed,
 * old value, new value, and timestamp.
 *
 * @param props - The component props
 * @returns The rendered history item
 */
function HistoryItem({ entry }: { entry: IssueHistory }) {
  return (
    <div className="flex gap-3 text-sm">
      <Avatar user={entry.user} size="sm" />
      <div>
        <span className="font-medium text-gray-900">{entry.user.name}</span>
        <span className="text-gray-500"> changed </span>
        <span className="font-medium text-gray-700">{entry.field}</span>
        {entry.old_value && (
          <>
            <span className="text-gray-500"> from </span>
            <span className="text-gray-700">{entry.old_value}</span>
          </>
        )}
        {entry.new_value && (
          <>
            <span className="text-gray-500"> to </span>
            <span className="text-gray-700">{entry.new_value}</span>
          </>
        )}
        <div className="text-gray-400 text-xs">
          {formatDistanceToNow(new Date(entry.created_at), { addSuffix: true })}
        </div>
      </div>
    </div>
  );
}
