import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { Subreddit } from '../types';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/submit')({
  component: SubmitPage,
  validateSearch: (search: Record<string, unknown>): { subreddit?: string } => ({
    subreddit: search.subreddit as string | undefined,
  }),
});

function SubmitPage() {
  const navigate = useNavigate();
  const { subreddit: preselectedSubreddit } = Route.useSearch();
  const user = useAuthStore((state) => state.user);

  const [subreddits, setSubreddits] = useState<Subreddit[]>([]);
  const [selectedSubreddit, setSelectedSubreddit] = useState(preselectedSubreddit || '');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [postType, setPostType] = useState<'text' | 'link'>('text');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listSubreddits().then(setSubreddits).catch(console.error);
  }, []);

  useEffect(() => {
    if (!user) {
      navigate({ to: '/login' });
    }
  }, [user, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSubreddit || !title.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const post = await api.createPost(
        selectedSubreddit,
        title.trim(),
        postType === 'text' ? content.trim() || undefined : undefined,
        postType === 'link' ? url.trim() || undefined : undefined
      );
      navigate({
        to: '/r/$subreddit/comments/$postId',
        params: { subreddit: selectedSubreddit, postId: post.id.toString() },
      });
    } catch (err) {
      setError((err as Error).message);
      setIsSubmitting(false);
    }
  };

  if (!user) {
    return null;
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-lg font-medium mb-4">Create a post</h1>

      <div className="bg-white rounded border border-gray-200 p-4">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-2 rounded mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Subreddit selector */}
          <div>
            <label className="block text-sm font-medium mb-1">Choose a community</label>
            <select
              value={selectedSubreddit}
              onChange={(e) => setSelectedSubreddit(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:border-reddit-blue"
              required
            >
              <option value="">Select a community</option>
              {subreddits.map((sub) => (
                <option key={sub.id} value={sub.name}>
                  r/{sub.name}
                </option>
              ))}
            </select>
          </div>

          {/* Post type tabs */}
          <div className="flex border-b border-gray-200">
            <button
              type="button"
              onClick={() => setPostType('text')}
              className={`px-4 py-2 text-sm font-medium border-b-2 ${
                postType === 'text'
                  ? 'border-reddit-blue text-reddit-blue'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Text
            </button>
            <button
              type="button"
              onClick={() => setPostType('link')}
              className={`px-4 py-2 text-sm font-medium border-b-2 ${
                postType === 'link'
                  ? 'border-reddit-blue text-reddit-blue'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Link
            </button>
          </div>

          {/* Title */}
          <div>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title"
              maxLength={300}
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:border-reddit-blue"
              required
            />
            <p className="text-xs text-gray-500 mt-1 text-right">{title.length}/300</p>
          </div>

          {/* Content or URL */}
          {postType === 'text' ? (
            <div>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Text (optional)"
                className="w-full px-3 py-2 border border-gray-300 rounded resize-none focus:outline-none focus:border-reddit-blue"
                rows={6}
              />
            </div>
          ) : (
            <div>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="URL"
                className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:border-reddit-blue"
              />
            </div>
          )}

          {/* Submit button */}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={isSubmitting || !selectedSubreddit || !title.trim()}
              className="px-6 py-2 bg-reddit-blue text-white rounded-full font-medium disabled:opacity-50"
            >
              {isSubmitting ? 'Posting...' : 'Post'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
