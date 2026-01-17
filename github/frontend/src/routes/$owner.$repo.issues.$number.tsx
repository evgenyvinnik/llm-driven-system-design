import { createFileRoute, Link, useParams } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { LabelBadge } from '../components/IssueCard';
import { CircleDot, CheckCircle, MessageSquare, Tag, User } from 'lucide-react';
import type { Issue as IssueType } from '../types';

export const Route = createFileRoute('/$owner/$repo/issues/$number')({
  component: IssuePage,
});

function IssuePage() {
  const { owner, repo, number } = useParams({ from: '/$owner/$repo/issues/$number' });
  const { user } = useAuthStore();
  const [issue, setIssue] = useState<IssueType | null>(null);
  const [newComment, setNewComment] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchIssue() {
      setLoading(true);
      try {
        const data = await api.getIssue(owner, repo, parseInt(number));
        setIssue(data);
      } catch (err) {
        console.error('Failed to fetch issue:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchIssue();
  }, [owner, repo, number]);

  const handleAddComment = async () => {
    if (!newComment.trim() || !issue) return;
    try {
      const comment = await api.addIssueComment(owner, repo, parseInt(number), newComment);
      setIssue({
        ...issue,
        comments: [...(issue.comments || []), { ...comment, user_name: user?.username }],
      });
      setNewComment('');
    } catch (err) {
      console.error('Failed to add comment:', err);
    }
  };

  const handleCloseIssue = async () => {
    if (!issue) return;
    try {
      await api.updateIssue(owner, repo, parseInt(number), {
        state: issue.state === 'open' ? 'closed' : 'open',
      });
      setIssue({ ...issue, state: issue.state === 'open' ? 'closed' : 'open' });
    } catch (err) {
      console.error('Failed to update issue:', err);
    }
  };

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="text-github-muted">Loading issue...</div>
      </div>
    );
  }

  if (!issue) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="text-github-danger">Issue not found</div>
      </div>
    );
  }

  const stateIcon = issue.state === 'open' ? (
    <CircleDot className="w-5 h-5 text-github-success" />
  ) : (
    <CheckCircle className="w-5 h-5 text-purple-500" />
  );

  const stateColor = issue.state === 'open' ? 'bg-github-success' : 'bg-purple-500';

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white mb-2">
          {issue.title} <span className="text-github-muted font-normal">#{issue.number}</span>
        </h1>
        <div className="flex items-center space-x-4">
          <span className={`flex items-center space-x-1 px-3 py-1 ${stateColor} text-white text-sm rounded-full`}>
            {stateIcon}
            <span className="capitalize">{issue.state}</span>
          </span>
          <span className="text-github-muted text-sm">
            <span className="font-semibold text-github-text">{issue.author_name}</span>
            {' '}opened this issue on {formatDate(issue.created_at)}
          </span>
        </div>
      </div>

      <div className="grid lg:grid-cols-4 gap-6">
        {/* Main content */}
        <div className="lg:col-span-3 space-y-4">
          {/* Issue body */}
          {issue.body && (
            <div className="border border-github-border rounded-md">
              <div className="px-4 py-2 bg-github-surface border-b border-github-border flex items-center space-x-2">
                <div className="w-8 h-8 rounded-full bg-github-accent flex items-center justify-center text-white text-sm">
                  {issue.author_name.charAt(0).toUpperCase()}
                </div>
                <span className="font-semibold text-github-text">{issue.author_name}</span>
                <span className="text-github-muted text-sm">commented {formatDate(issue.created_at)}</span>
              </div>
              <div className="p-4 text-github-text whitespace-pre-wrap">{issue.body}</div>
            </div>
          )}

          {/* Comments */}
          {issue.comments?.map((comment) => (
            <div key={comment.id} className="border border-github-border rounded-md">
              <div className="px-4 py-2 bg-github-surface border-b border-github-border flex items-center space-x-2">
                <div className="w-8 h-8 rounded-full bg-github-muted flex items-center justify-center text-white text-sm">
                  {comment.user_name?.charAt(0).toUpperCase() || '?'}
                </div>
                <span className="font-semibold text-github-text">{comment.user_name}</span>
                <span className="text-github-muted text-sm">commented {formatDate(comment.created_at)}</span>
              </div>
              <div className="p-4 text-github-text whitespace-pre-wrap">{comment.body}</div>
            </div>
          ))}

          {/* Add comment */}
          {user && (
            <div className="border border-github-border rounded-md">
              <textarea
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Leave a comment"
                className="w-full p-4 bg-github-bg border-b border-github-border rounded-t-md focus:outline-none resize-none"
                rows={4}
              />
              <div className="p-4 flex justify-between items-center">
                <button
                  onClick={handleCloseIssue}
                  className="px-4 py-1.5 border border-github-border text-github-text text-sm rounded-md hover:bg-github-surface"
                >
                  {issue.state === 'open' ? 'Close issue' : 'Reopen issue'}
                </button>
                <button
                  onClick={handleAddComment}
                  disabled={!newComment.trim()}
                  className="px-4 py-1.5 bg-github-success text-white text-sm rounded-md hover:bg-green-600 disabled:opacity-50"
                >
                  Comment
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="lg:col-span-1 space-y-4">
          {/* Assignees */}
          <div className="border border-github-border rounded-md p-4">
            <h3 className="text-sm font-semibold text-github-text mb-2 flex items-center space-x-1">
              <User className="w-4 h-4" />
              <span>Assignees</span>
            </h3>
            {issue.assignee_name ? (
              <div className="flex items-center space-x-2">
                <div className="w-6 h-6 rounded-full bg-github-muted flex items-center justify-center text-white text-xs">
                  {issue.assignee_name.charAt(0).toUpperCase()}
                </div>
                <span className="text-sm text-github-text">{issue.assignee_name}</span>
              </div>
            ) : (
              <p className="text-sm text-github-muted">No one assigned</p>
            )}
          </div>

          {/* Labels */}
          <div className="border border-github-border rounded-md p-4">
            <h3 className="text-sm font-semibold text-github-text mb-2 flex items-center space-x-1">
              <Tag className="w-4 h-4" />
              <span>Labels</span>
            </h3>
            {issue.labels && issue.labels.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {issue.labels.map((label) => (
                  <LabelBadge key={label.id} label={label} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-github-muted">None yet</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
