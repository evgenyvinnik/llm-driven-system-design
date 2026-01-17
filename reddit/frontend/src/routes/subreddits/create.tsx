import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import api from '../../services/api';
import { useAuthStore } from '../../stores/authStore';

export const Route = createFileRoute('/subreddits/create')({
  component: CreateSubredditPage,
});

function CreateSubredditPage() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);

  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      navigate({ to: '/login' });
    }
  }, [user, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const subreddit = await api.createSubreddit(
        name.trim(),
        title.trim() || name.trim(),
        description.trim()
      );
      navigate({ to: '/r/$subreddit', params: { subreddit: subreddit.name } });
    } catch (err) {
      setError((err as Error).message);
      setIsSubmitting(false);
    }
  };

  if (!user) {
    return null;
  }

  return (
    <div className="max-w-xl mx-auto">
      <h1 className="text-xl font-bold mb-6">Create a community</h1>

      <div className="bg-white rounded border border-gray-200 p-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-2 rounded mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <div className="flex items-center">
              <span className="text-gray-500 mr-1">r/</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                className="flex-1 px-3 py-2 border border-gray-300 rounded focus:outline-none focus:border-reddit-blue"
                required
                minLength={3}
                maxLength={21}
                placeholder="community_name"
              />
            </div>
            <p className="text-xs text-gray-500 mt-1">
              3-21 characters. Letters, numbers, and underscores only.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:border-reddit-blue"
              placeholder="Community Title"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded resize-none focus:outline-none focus:border-reddit-blue"
              rows={4}
              placeholder="What is this community about?"
            />
          </div>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => navigate({ to: '/' })}
              className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !name.trim()}
              className="px-6 py-2 bg-reddit-blue text-white rounded-full font-medium disabled:opacity-50"
            >
              {isSubmitting ? 'Creating...' : 'Create Community'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
