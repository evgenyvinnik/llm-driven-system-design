import { useEffect, useState } from 'react';
import type { IssueWithDetails } from '../types';
import { Spinner } from './ui';
import { useIssueDetail } from '../hooks/useIssueDetail';
import { useAuthStore } from '../stores';
import {
  IssueDetailHeader,
  IssueDetailSidebar,
  IssueDetailTabs,
  IssueSummaryEditor,
  type IssueDetailTabType,
} from './issue-detail';

/**
 * Props for the IssueDetail component.
 */
interface IssueDetailProps {
  /** The issue to display with all related details */
  issue: IssueWithDetails;
  /** Callback when the detail panel should be closed */
  onClose: () => void;
}

/**
 * IssueDetail component displays a sliding panel with full issue details.
 *
 * This is the main container component for viewing and editing an issue.
 * It coordinates several sub-components:
 * - IssueDetailHeader: Displays issue type icon, key, and close button
 * - IssueSummaryEditor: Inline editing for summary and description
 * - IssueDetailTabs: Comments and history tabs
 * - IssueDetailSidebar: Issue metadata (status, assignee, priority, etc.)
 *
 * State management is handled by the useIssueDetail hook, which provides
 * all necessary state and actions for the component tree.
 *
 * @param props - The component props
 * @returns The rendered issue detail panel
 *
 * @example
 * ```tsx
 * <IssueDetail
 *   issue={selectedIssue}
 *   onClose={() => setSelectedIssue(null)}
 * />
 * ```
 */
export function IssueDetail({ issue: initialIssue, onClose }: IssueDetailProps) {
  const { state, actions } = useIssueDetail(initialIssue);
  const [activeTab, setActiveTab] = useState<IssueDetailTabType>('comments');
  const currentUser = useAuthStore((auth) => auth.user);

  useEffect(() => {
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const {
    issue,
    comments,
    history,
    transitions,
    users,
    isLoading,
    isSaving,
    isEditing,
    editedSummary,
    editedDescription,
    error,
  } = state;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black bg-opacity-50" onClick={onClose} />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Issue ${issue.key}`}
        className="absolute inset-y-0 right-0 w-full max-w-4xl bg-white shadow-xl flex flex-col"
      >
        <IssueDetailHeader issueType={issue.issue_type} issueKey={issue.key} onClose={onClose} />

        {error && (
          <div role="alert" className="mx-6 mt-4 p-3 bg-red-50 text-red-700 rounded text-sm flex items-start gap-3">
            <span className="flex-1">{error}</span>
            <button onClick={actions.dismissError} className="text-red-500 hover:text-red-700" aria-label="Dismiss">
              Dismiss
            </button>
          </div>
        )}

        {isLoading ? (
          <LoadingState />
        ) : (
          <div className="flex-1 overflow-y-auto">
            <div className="grid grid-cols-3 gap-6 p-6">
              {/* Main content area */}
              <div className="col-span-2 space-y-6">
                <IssueSummaryEditor
                  summary={editedSummary}
                  description={editedDescription}
                  isEditing={isEditing}
                  isSaving={isSaving}
                  onStartEdit={actions.startEditing}
                  onSummaryChange={actions.setEditedSummary}
                  onDescriptionChange={actions.setEditedDescription}
                  onSave={actions.saveChanges}
                  onCancel={actions.cancelEditing}
                />

                <IssueDetailTabs
                  activeTab={activeTab}
                  onTabChange={setActiveTab}
                  comments={comments}
                  history={history}
                  currentUser={currentUser ?? undefined}
                  onAddComment={actions.addComment}
                />
              </div>

              {/* Sidebar */}
              <IssueDetailSidebar
                issue={issue}
                transitions={transitions}
                users={users}
                onTransition={actions.executeTransition}
                onAssigneeChange={actions.changeAssignee}
                onPriorityChange={actions.changePriority}
                onStoryPointsChange={actions.changeStoryPoints}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Loading state component displayed while issue data is being fetched.
 *
 * @returns The rendered loading indicator
 */
function LoadingState() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <Spinner size="lg" />
    </div>
  );
}
