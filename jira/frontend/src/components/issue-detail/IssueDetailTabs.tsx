import { clsx } from 'clsx';
import type { Comment, IssueHistory, User } from '../../types';
import { CommentsTab } from './CommentsTab';
import { HistoryTab } from './HistoryTab';

/**
 * Available tab types for the issue detail view.
 */
export type IssueDetailTabType = 'comments' | 'history';

/**
 * Props for the IssueDetailTabs component.
 */
interface IssueDetailTabsProps {
  /** Currently active tab */
  activeTab: IssueDetailTabType;
  /** Callback when tab changes */
  onTabChange: (tab: IssueDetailTabType) => void;
  /** List of comments on the issue */
  comments: Comment[];
  /** List of history entries for the issue */
  history: IssueHistory[];
  /** The current user for showing the avatar in the comment form */
  currentUser?: User;
  /** Callback when a new comment is added */
  onAddComment: (body: string) => void;
}

/**
 * Tab navigation component.
 *
 * Renders the tab buttons for switching between Comments and History views.
 *
 * @param props - Tab navigation props
 * @returns The rendered tab navigation
 */
function TabNavigation({
  activeTab,
  onTabChange,
  commentsCount,
  historyCount,
}: {
  activeTab: IssueDetailTabType;
  onTabChange: (tab: IssueDetailTabType) => void;
  commentsCount: number;
  historyCount: number;
}) {
  /**
   * Gets the appropriate CSS classes for a tab button based on active state.
   */
  const getTabClasses = (tab: IssueDetailTabType) =>
    clsx(
      'py-2 px-1 border-b-2 font-medium text-sm',
      activeTab === tab
        ? 'border-blue-500 text-blue-600'
        : 'border-transparent text-gray-500 hover:text-gray-700'
    );

  return (
    <div className="border-b">
      <nav className="flex gap-4">
        <button onClick={() => onTabChange('comments')} className={getTabClasses('comments')}>
          Comments ({commentsCount})
        </button>
        <button onClick={() => onTabChange('history')} className={getTabClasses('history')}>
          History ({historyCount})
        </button>
      </nav>
    </div>
  );
}

/**
 * Tabbed content component for the issue detail panel.
 *
 * Provides tabs for viewing and adding comments, and viewing
 * the history of changes made to the issue.
 *
 * @param props - The component props
 * @returns The rendered tabs element
 */
export function IssueDetailTabs({
  activeTab,
  onTabChange,
  comments,
  history,
  currentUser,
  onAddComment,
}: IssueDetailTabsProps) {
  return (
    <>
      <TabNavigation
        activeTab={activeTab}
        onTabChange={onTabChange}
        commentsCount={comments.length}
        historyCount={history.length}
      />

      {activeTab === 'comments' && (
        <CommentsTab comments={comments} currentUser={currentUser} onAddComment={onAddComment} />
      )}

      {activeTab === 'history' && <HistoryTab history={history} />}
    </>
  );
}
