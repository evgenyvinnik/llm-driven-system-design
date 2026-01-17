import type { IssueType } from '../../types';
import { IssueTypeIcon } from '../ui';

/**
 * Props for the IssueDetailHeader component.
 */
interface IssueDetailHeaderProps {
  /** The issue type (bug, story, task, epic, subtask) */
  issueType: IssueType;
  /** The issue key (e.g., "PROJ-123") */
  issueKey: string;
  /** Callback when the close button is clicked */
  onClose: () => void;
}

/**
 * Header component for the issue detail panel.
 *
 * Displays the issue type icon, issue key, and a close button.
 * Used at the top of the sliding issue detail panel.
 *
 * @param props - The component props
 * @returns The rendered header element
 */
export function IssueDetailHeader({ issueType, issueKey, onClose }: IssueDetailHeaderProps) {
  return (
    <div className="flex items-center justify-between p-4 border-b">
      <div className="flex items-center gap-3">
        <IssueTypeIcon type={issueType} className="w-5 h-5" />
        <span className="font-medium text-gray-500">{issueKey}</span>
      </div>
      <button
        onClick={onClose}
        className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
        aria-label="Close issue detail"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
