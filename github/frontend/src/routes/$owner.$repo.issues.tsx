import { createFileRoute, Link, useParams, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { IssueCard } from '../components/IssueCard';
import { Plus, Search, CircleDot, CheckCircle } from 'lucide-react';

export const Route = createFileRoute('/$owner/$repo/issues')({
  component: IssuesPage,
});

function IssuesPage() {
  const { owner, repo } = useParams({ from: '/$owner/$repo/issues' });
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [issues, setIssues] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<'open' | 'closed'>('open');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchIssues() {
      setLoading(true);
      try {
        const data = await api.getIssues(owner, repo, { state });
        setIssues(data.issues);
        setTotal(data.total);
      } catch (err) {
        console.error('Failed to fetch issues:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchIssues();
  }, [owner, repo, state]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center space-x-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-github-muted" />
            <input
              type="text"
              placeholder="Search all issues"
              className="pl-10 pr-4 py-1.5 w-80 bg-github-bg border border-github-border rounded-md text-sm focus:outline-none focus:border-github-accent"
            />
          </div>
        </div>
        {user && (
          <Link
            to={`/${owner}/${repo}/issues/new`}
            className="flex items-center space-x-1 px-4 py-1.5 bg-github-success text-white text-sm rounded-md hover:bg-green-600"
          >
            <Plus className="w-4 h-4" />
            <span>New issue</span>
          </Link>
        )}
      </div>

      {/* Filters */}
      <div className="flex items-center space-x-4 mb-4 border-b border-github-border pb-4">
        <button
          onClick={() => setState('open')}
          className={`flex items-center space-x-1 text-sm ${
            state === 'open' ? 'text-white font-semibold' : 'text-github-muted hover:text-white'
          }`}
        >
          <CircleDot className="w-4 h-4" />
          <span>Open</span>
        </button>
        <button
          onClick={() => setState('closed')}
          className={`flex items-center space-x-1 text-sm ${
            state === 'closed' ? 'text-white font-semibold' : 'text-github-muted hover:text-white'
          }`}
        >
          <CheckCircle className="w-4 h-4" />
          <span>Closed</span>
        </button>
      </div>

      {/* Issues list */}
      {loading ? (
        <div className="text-github-muted py-8 text-center">Loading issues...</div>
      ) : issues.length === 0 ? (
        <div className="text-center py-16">
          <CircleDot className="w-12 h-12 text-github-muted mx-auto mb-4" />
          <h3 className="text-xl font-semibold text-white mb-2">
            {state === 'open' ? 'No open issues' : 'No closed issues'}
          </h3>
          <p className="text-github-muted mb-6">
            {state === 'open'
              ? 'There are no open issues in this repository.'
              : 'There are no closed issues in this repository.'}
          </p>
          {user && (
            <Link
              to={`/${owner}/${repo}/issues/new`}
              className="inline-flex items-center space-x-1 px-4 py-2 bg-github-success text-white rounded-md hover:bg-green-600"
            >
              <Plus className="w-4 h-4" />
              <span>New issue</span>
            </Link>
          )}
        </div>
      ) : (
        <div className="border border-github-border rounded-md">
          {issues.map((issue) => (
            <IssueCard key={issue.id} issue={issue} owner={owner} repo={repo} type="issue" />
          ))}
        </div>
      )}

      {/* Pagination info */}
      {total > 0 && (
        <div className="mt-4 text-sm text-github-muted">
          Showing {issues.length} of {total} issues
        </div>
      )}
    </div>
  );
}
