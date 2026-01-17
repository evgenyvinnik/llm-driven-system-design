import { createFileRoute, Link, useParams, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { IssueCard } from '../components/IssueCard';
import { Plus, Search, GitPullRequest, CheckCircle, GitMerge } from 'lucide-react';

export const Route = createFileRoute('/$owner/$repo/pulls')({
  component: PullsPage,
});

function PullsPage() {
  const { owner, repo } = useParams({ from: '/$owner/$repo/pulls' });
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [pulls, setPulls] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<'open' | 'closed'>('open');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchPulls() {
      setLoading(true);
      try {
        const data = await api.getPulls(owner, repo, state);
        setPulls(data.pulls);
        setTotal(data.total);
      } catch (err) {
        console.error('Failed to fetch pull requests:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchPulls();
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
              placeholder="Search all pull requests"
              className="pl-10 pr-4 py-1.5 w-80 bg-github-bg border border-github-border rounded-md text-sm focus:outline-none focus:border-github-accent"
            />
          </div>
        </div>
        {user && (
          <Link
            to={`/${owner}/${repo}/compare`}
            className="flex items-center space-x-1 px-4 py-1.5 bg-github-success text-white text-sm rounded-md hover:bg-green-600"
          >
            <Plus className="w-4 h-4" />
            <span>New pull request</span>
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
          <GitPullRequest className="w-4 h-4" />
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

      {/* Pull requests list */}
      {loading ? (
        <div className="text-github-muted py-8 text-center">Loading pull requests...</div>
      ) : pulls.length === 0 ? (
        <div className="text-center py-16">
          <GitPullRequest className="w-12 h-12 text-github-muted mx-auto mb-4" />
          <h3 className="text-xl font-semibold text-white mb-2">
            {state === 'open' ? 'No open pull requests' : 'No closed pull requests'}
          </h3>
          <p className="text-github-muted mb-6">
            {state === 'open'
              ? 'There are no open pull requests in this repository.'
              : 'There are no closed pull requests in this repository.'}
          </p>
          {user && (
            <Link
              to={`/${owner}/${repo}/compare`}
              className="inline-flex items-center space-x-1 px-4 py-2 bg-github-success text-white rounded-md hover:bg-green-600"
            >
              <Plus className="w-4 h-4" />
              <span>New pull request</span>
            </Link>
          )}
        </div>
      ) : (
        <div className="border border-github-border rounded-md">
          {pulls.map((pr) => (
            <IssueCard key={pr.id} issue={pr} owner={owner} repo={repo} type="pr" />
          ))}
        </div>
      )}

      {/* Pagination info */}
      {total > 0 && (
        <div className="mt-4 text-sm text-github-muted">
          Showing {pulls.length} of {total} pull requests
        </div>
      )}
    </div>
  );
}
