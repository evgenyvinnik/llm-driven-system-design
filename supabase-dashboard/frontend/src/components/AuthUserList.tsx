import type { AuthUser } from '../types';

interface AuthUserListProps {
  users: AuthUser[];
  loading: boolean;
  /** Both omitted for viewers, which hides the row actions. */
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
}

/** Displays a table of auth users with email, role, confirmation status, and edit/delete actions. */
export function AuthUserList({ users, loading, onEdit, onDelete }: AuthUserListProps) {
  if (loading) {
    return <div className="text-sm text-supabase-secondary">Loading users...</div>;
  }

  if (users.length === 0) {
    return (
      <div className="text-center py-12 text-supabase-secondary">
        <p>No auth users yet</p>
        <p className="text-sm mt-1">Add users to manage authentication</p>
      </div>
    );
  }

  return (
    <div className="bg-supabase-dark-surface border border-supabase-dark-border rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-supabase-dark-border">
            <th className="text-left px-4 py-3 text-xs font-medium text-supabase-secondary uppercase tracking-wider">Email</th>
            <th className="text-left px-4 py-3 text-xs font-medium text-supabase-secondary uppercase tracking-wider">Role</th>
            <th className="text-left px-4 py-3 text-xs font-medium text-supabase-secondary uppercase tracking-wider">Confirmed</th>
            <th className="text-left px-4 py-3 text-xs font-medium text-supabase-secondary uppercase tracking-wider">Last Sign In</th>
            <th className="text-left px-4 py-3 text-xs font-medium text-supabase-secondary uppercase tracking-wider">Created</th>
            <th className="px-4 py-3 w-24" />
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className="border-b border-supabase-dark-border last:border-0 hover:bg-supabase-surface/20 group">
              <td className="px-4 py-3 text-supabase-text">{user.email}</td>
              <td className="px-4 py-3">
                <span className="text-xs px-2 py-0.5 rounded bg-supabase-primary/10 text-supabase-primary">
                  {user.role}
                </span>
              </td>
              <td className="px-4 py-3">
                <span className={`w-2 h-2 rounded-full inline-block ${user.emailConfirmed ? 'bg-supabase-success' : 'bg-supabase-secondary'}`} />
              </td>
              <td className="px-4 py-3 text-supabase-secondary text-xs">
                {user.lastSignInAt ? new Date(user.lastSignInAt).toLocaleString() : '-'}
              </td>
              <td className="px-4 py-3 text-supabase-secondary text-xs">
                {new Date(user.createdAt).toLocaleDateString()}
              </td>
              <td className="px-4 py-3">
                {onEdit && onDelete && (
                  <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => onEdit(user.id)} className="text-supabase-secondary hover:text-supabase-text text-xs">Edit</button>
                    <button onClick={() => onDelete(user.id)} className="text-supabase-secondary hover:text-supabase-danger text-xs">Del</button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
