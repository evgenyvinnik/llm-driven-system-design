import { useEffect, useState } from 'react';
import { useProjectStore, useProjectRole } from '../stores/projectStore';
import { useAuthStore } from '../stores/authStore';
import type { ProjectRole } from '../types';

interface ProjectMembersProps {
  projectId: string;
}

const ROLES: ProjectRole[] = ['owner', 'editor', 'viewer'];

const ROLE_HELP: Record<ProjectRole, string> = {
  owner: 'settings, members, everything',
  editor: 'DDL, row edits, any SQL',
  viewer: 'read, read-only SQL',
};

/** Lists project members; owners can add people by username, change roles, and remove members. */
export function ProjectMembers({ projectId }: ProjectMembersProps) {
  const { members, loadMembers, addMember, removeMember } = useProjectStore();
  const { isOwner } = useProjectRole();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<ProjectRole>('editor');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadMembers(projectId);
  }, [projectId, loadMembers]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return;
    run(async () => {
      await addMember(projectId, username.trim(), role);
      setUsername('');
    });
  };

  return (
    <div className="bg-supabase-surface border border-supabase-border rounded-lg p-6 mt-6">
      <h3 className="text-sm font-medium text-supabase-text mb-1">Members</h3>
      <p className="text-xs text-supabase-secondary mb-4">
        {ROLES.map((r) => `${r}: ${ROLE_HELP[r]}`).join(' · ')}
      </p>

      {error && (
        <div className="mb-3 bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-2 rounded text-sm">{error}</div>
      )}

      <table className="w-full text-sm mb-4">
        <tbody>
          {members.map((m) => (
            <tr key={m.userId} className="border-b border-supabase-dark-border last:border-0">
              <td className="py-2 text-supabase-text">
                {m.displayName || m.username}
                <span className="text-supabase-secondary ml-2 text-xs">@{m.username}</span>
                {m.isCreator && <span className="text-supabase-secondary ml-2 text-xs">(creator)</span>}
              </td>
              <td className="py-2 w-36">
                {isOwner && !m.isCreator ? (
                  <select
                    value={m.role}
                    disabled={busy}
                    onChange={(e) => run(() => addMember(projectId, m.username, e.target.value))}
                    className="bg-supabase-dark-surface border border-supabase-border rounded px-2 py-1 text-xs text-supabase-text"
                    aria-label={`Role for ${m.username}`}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                ) : (
                  <span className="text-xs px-2 py-0.5 rounded bg-supabase-primary/10 text-supabase-primary">{m.role}</span>
                )}
              </td>
              <td className="py-2 w-20 text-right">
                {!m.isCreator && (isOwner || m.userId === currentUserId) && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      const leaving = m.userId === currentUserId;
                      if (confirm(leaving ? 'Leave this project?' : `Remove ${m.username} from this project?`)) {
                        run(() => removeMember(projectId, m.userId));
                      }
                    }}
                    className="text-xs text-supabase-secondary hover:text-supabase-danger"
                  >
                    {m.userId === currentUserId ? 'Leave' : 'Remove'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {isOwner && (
        <form onSubmit={handleAdd} className="flex gap-2">
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            className="flex-1 bg-supabase-dark-surface border border-supabase-border rounded px-3 py-2 text-supabase-text text-sm focus:outline-none focus:border-supabase-primary"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as ProjectRole)}
            className="bg-supabase-dark-surface border border-supabase-border rounded px-2 py-2 text-sm text-supabase-text"
            aria-label="Role for new member"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <button
            type="submit"
            disabled={busy || !username.trim()}
            className="bg-supabase-primary hover:bg-supabase-hover text-black px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50"
          >
            Add member
          </button>
        </form>
      )}
    </div>
  );
}
