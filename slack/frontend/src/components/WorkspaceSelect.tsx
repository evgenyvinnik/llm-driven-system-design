import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { workspaceApi } from '../services/api';
import { useWorkspaceStore } from '../stores';

export function WorkspaceSelect() {
  const [mode, setMode] = useState<'list' | 'create' | 'join'>('list');
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const { workspaces, setWorkspaces, setCurrentWorkspace } = useWorkspaceStore();
  const navigate = useNavigate();

  const handleSelectWorkspace = async (workspaceId: string) => {
    try {
      await workspaceApi.select(workspaceId);
      const workspace = workspaces.find((w) => w.id === workspaceId);
      if (workspace) {
        setCurrentWorkspace(workspace);
        navigate({ to: '/workspace/$workspaceId', params: { workspaceId } });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select workspace');
    }
  };

  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const workspace = await workspaceApi.create(name, domain);
      setWorkspaces([...workspaces, workspace]);
      setCurrentWorkspace(workspace);
      navigate({ to: '/workspace/$workspaceId', params: { workspaceId: workspace.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
    } finally {
      setIsLoading(false);
    }
  };

  const handleJoinWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const workspace = await workspaceApi.getByDomain(domain);
      await workspaceApi.join(workspace.id);
      const updatedWorkspaces = await workspaceApi.list();
      setWorkspaces(updatedWorkspaces);
      setCurrentWorkspace(workspace);
      navigate({ to: '/workspace/$workspaceId', params: { workspaceId: workspace.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join workspace');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slack-purple">
      <div className="bg-white rounded-lg shadow-xl p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-slack-purple mb-2">
            {mode === 'list' && 'Your Workspaces'}
            {mode === 'create' && 'Create a Workspace'}
            {mode === 'join' && 'Join a Workspace'}
          </h1>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {mode === 'list' && (
          <>
            {workspaces.length > 0 ? (
              <div className="space-y-2 mb-6">
                {workspaces.map((workspace) => (
                  <button
                    key={workspace.id}
                    onClick={() => handleSelectWorkspace(workspace.id)}
                    className="w-full text-left p-4 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <div className="font-medium text-gray-900">{workspace.name}</div>
                    <div className="text-sm text-gray-500">{workspace.domain}.slack.com</div>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-center text-gray-500 mb-6">
                You're not a member of any workspaces yet.
              </p>
            )}

            <div className="space-y-2">
              <button
                onClick={() => setMode('create')}
                className="w-full bg-slack-green text-white py-2 px-4 rounded-md hover:bg-opacity-90 transition-colors"
              >
                Create a New Workspace
              </button>
              <button
                onClick={() => setMode('join')}
                className="w-full border border-slack-purple text-slack-purple py-2 px-4 rounded-md hover:bg-gray-50 transition-colors"
              >
                Join an Existing Workspace
              </button>
            </div>
          </>
        )}

        {mode === 'create' && (
          <form onSubmit={handleCreateWorkspace} className="space-y-4">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
                Workspace Name
              </label>
              <input
                type="text"
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slack-blue"
                placeholder="Acme Corp"
                required
              />
            </div>

            <div>
              <label htmlFor="domain" className="block text-sm font-medium text-gray-700 mb-1">
                Workspace URL
              </label>
              <div className="flex items-center">
                <input
                  type="text"
                  id="domain"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-l-md focus:outline-none focus:ring-2 focus:ring-slack-blue"
                  placeholder="acme"
                  required
                />
                <span className="px-3 py-2 bg-gray-100 border border-l-0 border-gray-300 rounded-r-md text-gray-500">
                  .slack.com
                </span>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMode('list')}
                className="flex-1 border border-gray-300 text-gray-700 py-2 px-4 rounded-md hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isLoading}
                className="flex-1 bg-slack-green text-white py-2 px-4 rounded-md hover:bg-opacity-90 disabled:opacity-50"
              >
                {isLoading ? 'Creating...' : 'Create'}
              </button>
            </div>
          </form>
        )}

        {mode === 'join' && (
          <form onSubmit={handleJoinWorkspace} className="space-y-4">
            <div>
              <label htmlFor="joinDomain" className="block text-sm font-medium text-gray-700 mb-1">
                Workspace URL
              </label>
              <div className="flex items-center">
                <input
                  type="text"
                  id="joinDomain"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-l-md focus:outline-none focus:ring-2 focus:ring-slack-blue"
                  placeholder="acme"
                  required
                />
                <span className="px-3 py-2 bg-gray-100 border border-l-0 border-gray-300 rounded-r-md text-gray-500">
                  .slack.com
                </span>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMode('list')}
                className="flex-1 border border-gray-300 text-gray-700 py-2 px-4 rounded-md hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isLoading}
                className="flex-1 bg-slack-purple text-white py-2 px-4 rounded-md hover:bg-slack-purple-light disabled:opacity-50"
              >
                {isLoading ? 'Joining...' : 'Join'}
              </button>
            </div>

            <p className="text-sm text-gray-500 text-center">
              Try joining: <strong>acme</strong>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
