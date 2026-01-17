import { formatDistanceToNow } from 'date-fns';
import { clsx } from 'clsx';
import type { Comment, IssueHistory, User } from '../../types';
import { Avatar, Textarea, Button } from '../ui';

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
   * Gets the appropriate CSS classes for a tab button.
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
 * Props for the CommentsTab component.
 */
interface CommentsTabProps {
  /** List of comments to display */
  comments: Comment[];
  /** The current user for the avatar */
  currentUser?: User;
  /** Callback when a comment is submitted */
  onAddComment: (body: string) => void;
}

/**
 * Comments tab content component.
 *
 * Displays a comment form and list of existing comments.
 *
 * @param props - The component props
 * @returns The rendered comments tab
 */
function CommentsTab({ comments, currentUser, onAddComment }: CommentsTabProps) {
  const [newComment, setNewComment] = useState('');

  /**
   * Handles the submission of a new comment.
   */
  const handleSubmit = () => {
    if (!newComment.trim()) return;
    onAddComment(newComment);
    setNewComment('');
  };

  return (
    <div className="space-y-4">
      {/* Add comment form */}
      <div className="flex gap-3">
        <Avatar user={currentUser} />
        <div className="flex-1">
          <Textarea
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            placeholder="Add a comment..."
            rows={3}
          />
          <div className="mt-2">
            <Button size="sm" onClick={handleSubmit} disabled={!newComment.trim()}>
              Add Comment
            </Button>
          </div>
        </div>
      </div>

      {/* Comments list */}
      {comments.map((comment) => (
        <CommentItem key={comment.id} comment={comment} />
      ))}
    </div>
  );
}

/**
 * Individual comment display component.
 *
 * @param props - The component props
 * @returns The rendered comment item
 */
function CommentItem({ comment }: { comment: Comment }) {
  return (
    <div className="flex gap-3">
      <Avatar user={comment.author} />
      <div className="flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-gray-900">{comment.author.name}</span>
          <span className="text-sm text-gray-500">
            {formatDistanceToNow(new Date(comment.created_at), { addSuffix: true })}
          </span>
        </div>
        <p className="text-gray-700 mt-1">{comment.body}</p>
      </div>
    </div>
  );
}

/**
 * History tab content component.
 *
 * Displays a chronological list of changes made to the issue.
 *
 * @param props - The component props
 * @returns The rendered history tab
 */
function HistoryTab({ history }: { history: IssueHistory[] }) {
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

import { useState } from 'react';

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
