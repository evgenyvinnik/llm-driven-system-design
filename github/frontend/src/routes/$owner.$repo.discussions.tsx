import { createFileRoute, Link, useParams, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { MessageSquare, CheckCircle, Plus } from 'lucide-react';

export const Route = createFileRoute('/$owner/$repo/discussions')({
  component: DiscussionsPage,
});

function DiscussionsPage() {
  const { owner, repo } = useParams({ from: '/$owner/$repo/discussions' });
  const { user } = useAuthStore();
  const [discussions, setDiscussions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchDiscussions() {
      setLoading(true);
      try {
        const data = await api.getDiscussions(owner, repo);
        setDiscussions(data.discussions);
      } catch (err) {
        console.error('Failed to fetch discussions:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchDiscussions();
  }, [owner, repo]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Discussions</h1>
        {user && (
          <Link
            to={`/${owner}/${repo}/discussions/new`}
            className="flex items-center space-x-1 px-4 py-1.5 bg-github-success text-white text-sm rounded-md hover:bg-green-600"
          >
            <Plus className="w-4 h-4" />
            <span>New discussion</span>
          </Link>
        )}
      </div>

      {/* Discussions list */}
      {loading ? (
        <div className="text-github-muted py-8 text-center">Loading discussions...</div>
      ) : discussions.length === 0 ? (
        <div className="text-center py-16">
          <MessageSquare className="w-12 h-12 text-github-muted mx-auto mb-4" />
          <h3 className="text-xl font-semibold text-white mb-2">No discussions yet</h3>
          <p className="text-github-muted mb-6">
            Start a new discussion to begin the conversation.
          </p>
          {user && (
            <Link
              to={`/${owner}/${repo}/discussions/new`}
              className="inline-flex items-center space-x-1 px-4 py-2 bg-github-success text-white rounded-md hover:bg-green-600"
            >
              <Plus className="w-4 h-4" />
              <span>New discussion</span>
            </Link>
          )}
        </div>
      ) : (
        <div className="border border-github-border rounded-md">
          {discussions.map((discussion) => (
            <Link
              key={discussion.id}
              to={`/${owner}/${repo}/discussions/${discussion.number}`}
              className="block px-4 py-3 border-b border-github-border last:border-b-0 hover:bg-github-surface/50"
            >
              <div className="flex items-start space-x-3">
                <MessageSquare className={`w-5 h-5 mt-1 ${discussion.is_answered ? 'text-github-success' : 'text-github-muted'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-2">
                    <span className="text-github-text font-semibold hover:text-github-accent">
                      {discussion.title}
                    </span>
                    {discussion.is_answered && (
                      <span className="flex items-center space-x-1 text-xs text-github-success">
                        <CheckCircle className="w-3 h-3" />
                        <span>Answered</span>
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-github-muted">
                    #{discussion.number} started by {discussion.author_name}
                    {' '}&middot;{' '}
                    {discussion.comments_count || 0} comments
                  </p>
                </div>
                <span className="text-xs px-2 py-0.5 bg-github-surface border border-github-border rounded-full text-github-muted">
                  {discussion.category}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
