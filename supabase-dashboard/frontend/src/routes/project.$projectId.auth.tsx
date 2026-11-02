import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useProjectStore, useProjectRole } from '../stores/projectStore';
import { AuthUserList } from '../components/AuthUserList';
import { AuthUserForm } from '../components/AuthUserForm';

function AuthPage() {
  const { projectId } = Route.useParams();
  const { authUsers, authUsersLoading, loadAuthUsers, createAuthUser, updateAuthUser, deleteAuthUser } = useProjectStore();
  const { canEdit } = useProjectRole();
  const [showForm, setShowForm] = useState(false);
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    loadAuthUsers(projectId);
  }, [projectId, loadAuthUsers]);

  const handleCreate = async (data: { email: string; password?: string; role?: string; emailConfirmed?: boolean }) => {
    await createAuthUser(projectId, data);
    setShowForm(false);
  };

  const handleUpdate = async (userId: string, data: { email?: string; password?: string; role?: string; emailConfirmed?: boolean }) => {
    await updateAuthUser(projectId, userId, data);
    setEditingUser(null);
  };

  const handleDelete = async (userId: string) => {
    if (!confirm('Delete this user? This cannot be undone.')) return;
    setDeleteError(null);
    try {
      await deleteAuthUser(projectId, userId);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete user');
    }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold text-supabase-text">Auth Users</h2>
          <p className="text-sm text-supabase-secondary mt-1">
            Manage authentication users for this project
          </p>
        </div>
        {canEdit && (
          <button
            onClick={() => setShowForm(true)}
            className="bg-supabase-primary hover:bg-supabase-hover text-black px-4 py-2 rounded-md text-sm font-medium transition-colors"
          >
            Add User
          </button>
        )}
      </div>

      {deleteError && (
        <div className="mb-4 bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-2 rounded text-sm">{deleteError}</div>
      )}

      {showForm && (
        <div className="mb-6">
          <AuthUserForm
            onSubmit={handleCreate}
            onCancel={() => setShowForm(false)}
          />
        </div>
      )}

      {editingUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-supabase-surface border border-supabase-border rounded-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold mb-4">Edit User</h3>
            <AuthUserForm
              initialData={authUsers.find((u) => u.id === editingUser)}
              onSubmit={(data) => handleUpdate(editingUser, data)}
              onCancel={() => setEditingUser(null)}
            />
          </div>
        </div>
      )}

      <AuthUserList
        users={authUsers}
        loading={authUsersLoading}
        onEdit={canEdit ? setEditingUser : undefined}
        onDelete={canEdit ? handleDelete : undefined}
      />
    </div>
  );
}

export const Route = createFileRoute('/project/$projectId/auth')({
  component: AuthPage,
});
