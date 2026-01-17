import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/new')({
  component: NewRepoPage,
});

function NewRepoPage() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [initWithReadme, setInitWithReadme] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) {
    navigate({ to: '/login' });
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await api.createRepo({ name, description, isPrivate, initWithReadme });
      navigate({ to: `/${user.username}/${name}` });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-white mb-2">Create a new repository</h1>
      <p className="text-github-muted mb-8">
        A repository contains all project files, including the revision history.
      </p>

      <form onSubmit={handleSubmit}>
        {error && (
          <div className="mb-4 p-3 bg-red-900/20 border border-red-800 rounded-md text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Owner and name */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-github-text mb-2">
            Owner <span className="text-github-danger">*</span>
          </label>
          <div className="flex items-center space-x-2">
            <div className="px-3 py-2 bg-github-surface border border-github-border rounded-md text-github-text">
              {user.username}
            </div>
            <span className="text-github-muted">/</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-awesome-repo"
              className="flex-1 px-3 py-2 bg-github-bg border border-github-border rounded-md focus:outline-none focus:border-github-accent focus:ring-1 focus:ring-github-accent"
              required
              pattern="[a-zA-Z0-9_-]+"
            />
          </div>
          <p className="mt-1 text-xs text-github-muted">
            Great repository names are short and memorable.
          </p>
        </div>

        {/* Description */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-github-text mb-2">
            Description <span className="text-github-muted">(optional)</span>
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-2 bg-github-bg border border-github-border rounded-md focus:outline-none focus:border-github-accent focus:ring-1 focus:ring-github-accent"
          />
        </div>

        {/* Visibility */}
        <div className="mb-6 border-t border-github-border pt-6">
          <div className="space-y-4">
            <label className="flex items-start space-x-3 cursor-pointer">
              <input
                type="radio"
                name="visibility"
                checked={!isPrivate}
                onChange={() => setIsPrivate(false)}
                className="mt-1"
              />
              <div>
                <div className="text-github-text font-medium">Public</div>
                <div className="text-sm text-github-muted">
                  Anyone on the internet can see this repository.
                </div>
              </div>
            </label>
            <label className="flex items-start space-x-3 cursor-pointer">
              <input
                type="radio"
                name="visibility"
                checked={isPrivate}
                onChange={() => setIsPrivate(true)}
                className="mt-1"
              />
              <div>
                <div className="text-github-text font-medium">Private</div>
                <div className="text-sm text-github-muted">
                  You choose who can see and commit to this repository.
                </div>
              </div>
            </label>
          </div>
        </div>

        {/* Initialize */}
        <div className="mb-6 border-t border-github-border pt-6">
          <h3 className="text-sm font-medium text-github-text mb-4">Initialize this repository with:</h3>
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              checked={initWithReadme}
              onChange={(e) => setInitWithReadme(e.target.checked)}
            />
            <span className="text-github-text">Add a README file</span>
          </label>
          <p className="mt-1 text-xs text-github-muted ml-6">
            This is where you can write a long description for your project.
          </p>
        </div>

        {/* Submit */}
        <div className="border-t border-github-border pt-6">
          <button
            type="submit"
            disabled={loading || !name}
            className="px-4 py-2 bg-github-success text-white font-semibold rounded-md hover:bg-green-600 disabled:opacity-50"
          >
            {loading ? 'Creating...' : 'Create repository'}
          </button>
        </div>
      </form>
    </div>
  );
}
