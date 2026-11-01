import { useState } from 'react';
import { drawingApi } from '../services/api';
import type { Collaborator } from '../types';

interface ShareDialogProps {
  drawingId: string;
  collaborators: Collaborator[];
  isOwner: boolean;
  onClose: () => void;
  onCollaboratorsChange: (collaborators: Collaborator[]) => void;
}

/** Renders the share dialog for generating collaboration links. */
export function ShareDialog({ drawingId, collaborators, isOwner, onClose, onCollaboratorsChange }: ShareDialogProps) {
  const [username, setUsername] = useState('');
  const [permission, setPermission] = useState('edit');
  const [error, setError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const handleAdd = async () => {
    if (!username.trim()) return;

    setIsAdding(true);
    setError(null);

    try {
      const response = await drawingApi.addCollaborator(drawingId, {
        username: username.trim(),
        permission,
      });

      // Re-sharing with someone changes their permission; replace, don't duplicate.
      onCollaboratorsChange([
        ...collaborators.filter((c) => c.userId !== response.collaborator.userId),
        response.collaborator,
      ]);
      setUsername('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsAdding(false);
    }
  };

  const handleRemove = async (userId: string) => {
    try {
      await drawingApi.removeCollaborator(drawingId, userId);
      onCollaboratorsChange(collaborators.filter((c) => c.userId !== userId));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100]" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">Share Drawing</h2>
          <button
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary text-xl leading-none"
          >
            x
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg mb-4 text-sm">
            {error}
          </div>
        )}

        {/* Add collaborator form */}
        {isOwner && (
          <div className="flex gap-2 mb-6">
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              className="flex-1 border border-panel-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary"
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            />
            <select
              value={permission}
              onChange={(e) => setPermission(e.target.value)}
              className="border border-panel-border rounded-lg px-2 py-2 text-sm"
            >
              <option value="view">View</option>
              <option value="edit">Edit</option>
            </select>
            <button
              onClick={handleAdd}
              disabled={isAdding || !username.trim()}
              className="bg-primary text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
            >
              {isAdding ? '...' : 'Add'}
            </button>
          </div>
        )}

        {/* Collaborator list */}
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
            Collaborators ({collaborators.length})
          </h3>
          {collaborators.length === 0 ? (
            <p className="text-sm text-text-muted py-4 text-center">
              No collaborators yet
            </p>
          ) : (
            collaborators.map((collab) => (
              <div
                key={collab.userId}
                className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-panel-bg"
              >
                <div>
                  <div className="text-sm font-medium text-text-primary">
                    {collab.displayName || collab.username}
                  </div>
                  <div className="text-xs text-text-secondary">
                    @{collab.username} · {collab.permission}
                  </div>
                </div>
                {isOwner && (
                  <button
                    onClick={() => handleRemove(collab.userId)}
                    className="text-xs text-danger hover:underline"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
