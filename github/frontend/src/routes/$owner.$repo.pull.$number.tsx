import { createFileRoute, Link, useParams } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { DiffViewer, FileDiffSummary } from '../components/DiffViewer';
import { LabelBadge } from '../components/IssueCard';
import { GitPullRequest, GitMerge, CheckCircle, XCircle, MessageSquare, GitCommit, FileText } from 'lucide-react';
import type { PullRequest as PRType, DiffStats } from '../types';

export const Route = createFileRoute('/$owner/$repo/pull/$number')({
  component: PullRequestPage,
});

function PullRequestPage() {
  const { owner, repo, number } = useParams({ from: '/$owner/$repo/pull/$number' });
  const { user } = useAuthStore();
  const [pr, setPr] = useState<PRType | null>(null);
  const [diff, setDiff] = useState<{ diff: string; stats: DiffStats } | null>(null);
  const [comments, setComments] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'conversation' | 'commits' | 'files'>('conversation');
  const [newComment, setNewComment] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchPR() {
      setLoading(true);
      try {
        const prData = await api.getPull(owner, repo, parseInt(number));
        setPr(prData);

        const diffData = await api.getPullDiff(owner, repo, parseInt(number));
        setDiff(diffData);

        const commentsData = await api.getPullComments(owner, repo, parseInt(number));
        setComments(commentsData);
      } catch (err) {
        console.error('Failed to fetch PR:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchPR();
  }, [owner, repo, number]);

  const handleAddComment = async () => {
    if (!newComment.trim()) return;
    try {
      const comment = await api.addPullComment(owner, repo, parseInt(number), newComment);
      setComments([...comments, { ...comment, user_name: user?.username }]);
      setNewComment('');
    } catch (err) {
      console.error('Failed to add comment:', err);
    }
  };

  const handleMerge = async () => {
    try {
      await api.mergePull(owner, repo, parseInt(number), 'merge');
      // Refresh PR
      const prData = await api.getPull(owner, repo, parseInt(number));
      setPr(prData);
    } catch (err) {
      console.error('Failed to merge:', err);
    }
  };

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="text-github-muted">Loading pull request...</div>
      </div>
    );
  }

  if (!pr) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="text-github-danger">Pull request not found</div>
      </div>
    );
  }

  const stateIcon = pr.state === 'merged' ? (
    <GitMerge className="w-5 h-5 text-purple-500" />
  ) : pr.state === 'closed' ? (
    <XCircle className="w-5 h-5 text-github-danger" />
  ) : (
    <GitPullRequest className="w-5 h-5 text-github-success" />
  );

  const stateColor = pr.state === 'merged' ? 'bg-purple-500' : pr.state === 'closed' ? 'bg-github-danger' : 'bg-github-success';

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white mb-2">
          {pr.title} <span className="text-github-muted font-normal">#{pr.number}</span>
        </h1>
        <div className="flex items-center space-x-4">
          <span className={`flex items-center space-x-1 px-3 py-1 ${stateColor} text-white text-sm rounded-full`}>
            {stateIcon}
            <span className="capitalize">{pr.state}</span>
          </span>
          <span className="text-github-muted text-sm">
            <span className="font-semibold text-github-text">{pr.author_name}</span>
            {' '}wants to merge {pr.commits?.length || 0} commits into{' '}
            <span className="font-mono bg-github-surface px-1 rounded">{pr.base_branch}</span>
            {' '}from{' '}
            <span className="font-mono bg-github-surface px-1 rounded">{pr.head_branch}</span>
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center space-x-4 border-b border-github-border mb-6">
        <button
          onClick={() => setActiveTab('conversation')}
          className={`flex items-center space-x-1 px-3 py-2 ${
            activeTab === 'conversation' ? 'border-b-2 border-github-accent text-white' : 'text-github-muted hover:text-white'
          }`}
        >
          <MessageSquare className="w-4 h-4" />
          <span>Conversation</span>
          <span className="px-2 py-0.5 bg-github-surface rounded-full text-xs">{comments.length}</span>
        </button>
        <button
          onClick={() => setActiveTab('commits')}
          className={`flex items-center space-x-1 px-3 py-2 ${
            activeTab === 'commits' ? 'border-b-2 border-github-accent text-white' : 'text-github-muted hover:text-white'
          }`}
        >
          <GitCommit className="w-4 h-4" />
          <span>Commits</span>
          <span className="px-2 py-0.5 bg-github-surface rounded-full text-xs">{pr.commits?.length || 0}</span>
        </button>
        <button
          onClick={() => setActiveTab('files')}
          className={`flex items-center space-x-1 px-3 py-2 ${
            activeTab === 'files' ? 'border-b-2 border-github-accent text-white' : 'text-github-muted hover:text-white'
          }`}
        >
          <FileText className="w-4 h-4" />
          <span>Files changed</span>
          <span className="px-2 py-0.5 bg-github-surface rounded-full text-xs">{pr.changed_files}</span>
        </button>
      </div>

      <div className="grid lg:grid-cols-4 gap-6">
        {/* Main content */}
        <div className="lg:col-span-3">
          {activeTab === 'conversation' && (
            <div className="space-y-4">
              {/* PR body */}
              {pr.body && (
                <div className="border border-github-border rounded-md">
                  <div className="px-4 py-2 bg-github-surface border-b border-github-border flex items-center space-x-2">
                    <div className="w-8 h-8 rounded-full bg-github-accent flex items-center justify-center text-white text-sm">
                      {pr.author_name.charAt(0).toUpperCase()}
                    </div>
                    <span className="font-semibold text-github-text">{pr.author_name}</span>
                    <span className="text-github-muted text-sm">commented</span>
                  </div>
                  <div className="p-4 text-github-text">{pr.body}</div>
                </div>
              )}

              {/* Comments */}
              {comments.map((comment) => (
                <div key={comment.id} className="border border-github-border rounded-md">
                  <div className="px-4 py-2 bg-github-surface border-b border-github-border flex items-center space-x-2">
                    <div className="w-8 h-8 rounded-full bg-github-muted flex items-center justify-center text-white text-sm">
                      {comment.user_name?.charAt(0).toUpperCase() || '?'}
                    </div>
                    <span className="font-semibold text-github-text">{comment.user_name}</span>
                    <span className="text-github-muted text-sm">commented</span>
                  </div>
                  <div className="p-4 text-github-text">{comment.body}</div>
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
                  <div className="p-4 flex justify-end">
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
          )}

          {activeTab === 'commits' && (
            <div className="border border-github-border rounded-md">
              {pr.commits?.map((commit) => (
                <div key={commit.sha} className="px-4 py-3 border-b border-github-border last:border-b-0 hover:bg-github-surface/50">
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-github-text truncate">{commit.message}</p>
                      <p className="text-sm text-github-muted mt-1">
                        {commit.author.name} committed
                      </p>
                    </div>
                    <Link
                      to={`/${owner}/${repo}/commit/${commit.sha}`}
                      className="font-mono text-sm text-github-accent hover:underline"
                    >
                      {commit.sha.slice(0, 7)}
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'files' && diff && (
            <div className="space-y-4">
              {/* File summary */}
              <div className="border border-github-border rounded-md">
                <div className="px-4 py-2 bg-github-surface border-b border-github-border">
                  <span className="text-sm text-github-text">
                    Showing <strong>{diff.stats.files.length}</strong> changed files with{' '}
                    <span className="text-github-success">{diff.stats.additions} additions</span> and{' '}
                    <span className="text-github-danger">{diff.stats.deletions} deletions</span>
                  </span>
                </div>
                {diff.stats.files.map((file) => (
                  <FileDiffSummary key={file.path} file={file} />
                ))}
              </div>

              {/* Full diff */}
              <DiffViewer diff={diff.diff} />
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="lg:col-span-1 space-y-4">
          {/* Reviewers */}
          <div className="border border-github-border rounded-md p-4">
            <h3 className="text-sm font-semibold text-github-text mb-2">Reviewers</h3>
            {pr.reviews && pr.reviews.length > 0 ? (
              <div className="space-y-2">
                {pr.reviews.map((review) => (
                  <div key={review.id} className="flex items-center space-x-2">
                    <div className="w-6 h-6 rounded-full bg-github-muted flex items-center justify-center text-white text-xs">
                      {review.reviewer_name?.charAt(0).toUpperCase() || '?'}
                    </div>
                    <span className="text-sm text-github-text">{review.reviewer_name}</span>
                    {review.state === 'approved' && <CheckCircle className="w-4 h-4 text-github-success" />}
                    {review.state === 'changes_requested' && <XCircle className="w-4 h-4 text-github-danger" />}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-github-muted">No reviews yet</p>
            )}
          </div>

          {/* Labels */}
          <div className="border border-github-border rounded-md p-4">
            <h3 className="text-sm font-semibold text-github-text mb-2">Labels</h3>
            {pr.labels && pr.labels.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {pr.labels.map((label) => (
                  <LabelBadge key={label.id} label={label} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-github-muted">None yet</p>
            )}
          </div>

          {/* Merge */}
          {pr.state === 'open' && user && (
            <div className="border border-github-border rounded-md p-4">
              <button
                onClick={handleMerge}
                className="w-full px-4 py-2 bg-github-success text-white font-semibold rounded-md hover:bg-green-600"
              >
                Merge pull request
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
