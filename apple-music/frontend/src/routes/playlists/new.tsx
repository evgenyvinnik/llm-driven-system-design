import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { playlistApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';

export const Route = createFileRoute('/playlists/new')({
  component: NewPlaylist,
});

function NewPlaylist() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  if (!user) {
    navigate({ to: '/login' });
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Playlist name is required');
      return;
    }

    setIsLoading(true);
    try {
      const playlist = await playlistApi.createPlaylist(name, description, isPublic);
      navigate({ to: '/playlists/$id', params: { id: playlist.id } });
    } catch (err) {
      setError((err as Error).message || 'Failed to create playlist');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="p-8 max-w-xl mx-auto">
      <h1 className="text-3xl font-bold mb-8">New Playlist</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="bg-red-500/20 border border-red-500 text-red-200 px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="name" className="block text-sm font-medium mb-2">
            Name *
          </label>
          <input
            type="text"
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-4 py-3 bg-apple-card border border-apple-border rounded-lg focus:outline-none focus:border-apple-red transition"
            placeholder="My Awesome Playlist"
            required
          />
        </div>

        <div>
          <label htmlFor="description" className="block text-sm font-medium mb-2">
            Description
          </label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full px-4 py-3 bg-apple-card border border-apple-border rounded-lg focus:outline-none focus:border-apple-red transition resize-none"
            placeholder="Add an optional description..."
          />
        </div>

        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="isPublic"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            className="w-5 h-5 rounded bg-apple-card border-apple-border text-apple-red focus:ring-apple-red"
          />
          <label htmlFor="isPublic" className="text-sm">
            Make this playlist public
          </label>
        </div>

        <div className="flex gap-4">
          <button
            type="button"
            onClick={() => navigate({ to: '/library' })}
            className="flex-1 py-3 bg-apple-card hover:bg-white/10 border border-apple-border rounded-lg font-medium transition"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isLoading}
            className="flex-1 py-3 bg-apple-red hover:bg-apple-red/80 rounded-lg font-medium transition disabled:opacity-50"
          >
            {isLoading ? 'Creating...' : 'Create Playlist'}
          </button>
        </div>
      </form>
    </div>
  );
}
