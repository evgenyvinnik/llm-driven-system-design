import { formatDistanceToNow } from 'date-fns';
import type { IssueWithDetails, Transition, User } from '../../types';
import { IssueTypeIcon, StatusBadge, Avatar, Select } from '../ui';

/**
 * Props for the IssueDetailSidebar component.
 */
interface IssueDetailSidebarProps {
  /** The issue with all related details */
  issue: IssueWithDetails;
  /** Available transitions for the current status */
  transitions: Transition[];
  /** List of all users for assignee selection */
  users: User[];
  /** Callback when a transition is executed */
  onTransition: (transitionId: number) => void;
  /** Callback when the assignee is changed */
  onAssigneeChange: (assigneeId: string) => void;
  /** Callback when the priority is changed */
  onPriorityChange: (priority: string) => void;
  /** Callback when story points are changed */
  onStoryPointsChange: (points: string) => void;
}

/**
 * Priority options for the priority selector.
 */
const PRIORITY_OPTIONS = [
  { value: 'highest', label: 'Highest' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'lowest', label: 'Lowest' },
];

/**
 * Story points options following Fibonacci sequence.
 */
const STORY_POINTS_OPTIONS = [
  { value: '', label: 'None' },
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '5', label: '5' },
  { value: '8', label: '8' },
  { value: '13', label: '13' },
  { value: '21', label: '21' },
];

/**
 * Sidebar component for the issue detail panel.
 *
 * Displays and allows editing of issue metadata including:
 * - Status with available transitions
 * - Assignee
 * - Reporter (read-only)
 * - Priority
 * - Story Points
 * - Epic (if linked)
 * - Sprint (if assigned)
 * - Created and updated timestamps
 *
 * @param props - The component props
 * @returns The rendered sidebar element
 */
export function IssueDetailSidebar({
  issue,
  transitions,
  users,
  onTransition,
  onAssigneeChange,
  onPriorityChange,
  onStoryPointsChange,
}: IssueDetailSidebarProps) {
  /**
   * Builds the options array for the assignee select dropdown.
   */
  const assigneeOptions = [
    { value: '', label: 'Unassigned' },
    ...users.map((u) => ({ value: u.id, label: u.name })),
  ];

  return (
    <div className="space-y-6">
      {/* Status & Transitions */}
      <section>
        <h3 className="text-sm font-medium text-gray-500 mb-2">Status</h3>
        <StatusBadge name={issue.status.name} category={issue.status.category} />

        {transitions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {transitions.map((t) => (
              <button
                key={t.id}
                onClick={() => onTransition(t.id)}
                className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded text-gray-600"
              >
                {t.name}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Assignee */}
      <section>
        <h3 className="text-sm font-medium text-gray-500 mb-2">Assignee</h3>
        <Select
          value={issue.assignee_id || ''}
          onChange={(e) => onAssigneeChange(e.target.value)}
          options={assigneeOptions}
        />
      </section>

      {/* Reporter */}
      <section>
        <h3 className="text-sm font-medium text-gray-500 mb-2">Reporter</h3>
        <div className="flex items-center gap-2">
          <Avatar user={issue.reporter} size="sm" />
          <span className="text-gray-700">{issue.reporter.name}</span>
        </div>
      </section>

      {/* Priority */}
      <section>
        <h3 className="text-sm font-medium text-gray-500 mb-2">Priority</h3>
        <Select
          value={issue.priority}
          onChange={(e) => onPriorityChange(e.target.value)}
          options={PRIORITY_OPTIONS}
        />
      </section>

      {/* Story Points */}
      <section>
        <h3 className="text-sm font-medium text-gray-500 mb-2">Story Points</h3>
        <Select
          value={issue.story_points?.toString() || ''}
          onChange={(e) => onStoryPointsChange(e.target.value)}
          options={STORY_POINTS_OPTIONS}
        />
      </section>

      {/* Epic */}
      {issue.epic && (
        <section>
          <h3 className="text-sm font-medium text-gray-500 mb-2">Epic</h3>
          <div className="text-sm px-2 py-1 bg-purple-100 text-purple-700 rounded inline-flex items-center gap-1">
            <IssueTypeIcon type="epic" className="w-3 h-3" />
            {issue.epic.key}: {issue.epic.summary}
          </div>
        </section>
      )}

      {/* Sprint */}
      {issue.sprint && (
        <section>
          <h3 className="text-sm font-medium text-gray-500 mb-2">Sprint</h3>
          <span className="text-gray-700">{issue.sprint.name}</span>
        </section>
      )}

      {/* Dates */}
      <section className="text-sm text-gray-500 space-y-1">
        <div>Created: {formatDistanceToNow(new Date(issue.created_at), { addSuffix: true })}</div>
        <div>Updated: {formatDistanceToNow(new Date(issue.updated_at), { addSuffix: true })}</div>
      </section>
    </div>
  );
}
