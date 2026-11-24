/**
 * @fileoverview Operator account management (admins only).
 *
 * Lists accounts and lets an admin add users, change roles, disable/enable,
 * reset passwords, and delete. The server enforces the rules; the UI mirrors
 * them so they're visible before a click fails:
 * - your own row can't be demoted, disabled, or deleted
 * - the last active admin can't be demoted, disabled, or deleted (409)
 * - role / disable / password changes sign the affected user out everywhere
 *
 * @module components/UsersPanel
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ManagedUser } from '../types';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';

type Role = 'admin' | 'user';

export function UsersPanel() {
  const me = useAuthStore((s) => s.user);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [busyId, setBusyId] = useState<number | 'new' | null>(null);
  const [form, setForm] = useState<{ username: string; password: string; role: Role }>({
    username: '',
    password: '',
    role: 'user',
  });

  const load = useCallback(async () => {
    try {
      setUsers((await api.listUsers()).users);
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Failed to load users', ok: false });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (id: number | 'new', fn: () => Promise<unknown>, done: string) => {
    setBusyId(id);
    setMessage(null);
    try {
      await fn();
      setMessage({ text: done, ok: true });
      await load();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Action failed', ok: false });
    } finally {
      setBusyId(null);
    }
  };

  const activeAdmins = users.filter((u) => u.role === 'admin' && !u.disabled).length;

  const handleCreate = (e: FormEvent) => {
    e.preventDefault();
    act(
      'new',
      async () => {
        await api.createUser(form.username, form.password, form.role);
        setForm({ username: '', password: '', role: 'user' });
      },
      `Created ${form.username.trim().toLowerCase()}.`
    );
  };

  const resetPassword = (u: ManagedUser) => {
    const password = window.prompt(`New password for ${u.username} (at least 8 characters):`);
    if (!password) return;
    act(u.id, () => api.updateUser(u.id, { password }), `Password reset for ${u.username}; their sessions were signed out.`);
  };

  const remove = (u: ManagedUser) => {
    if (!window.confirm(`Delete ${u.username}? This can't be undone.`)) return;
    act(u.id, () => api.deleteUser(u.id), `Deleted ${u.username}.`);
  };

  const small = 'px-2 py-1 text-xs rounded-md border disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 space-y-4 lg:col-span-2">
      <div>
        <h2 className="text-lg font-medium text-gray-900">Operator accounts</h2>
        <p className="text-sm text-gray-600">
          Admins can change crawler state and manage accounts; users are read-only. Changing a
          role, disabling an account, or resetting a password signs that person out everywhere.
        </p>
      </div>

      {message && (
        <p role={message.ok ? 'status' : 'alert'} className={`text-sm ${message.ok ? 'text-green-700' : 'text-red-700'}`}>
          {message.text}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase text-gray-500 border-b border-gray-200">
            <tr>
              <th className="py-2 pr-4">Username</th>
              <th className="py-2 pr-4">Role</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Last login</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map((u) => {
              const isSelf = u.id === me?.id;
              const isLastAdmin = u.role === 'admin' && !u.disabled && activeAdmins === 1;
              const locked = isSelf || isLastAdmin;
              const lockReason = isSelf ? 'You can’t change your own role or status' : 'Last active admin';
              const busy = busyId === u.id;
              return (
                <tr key={u.id}>
                  <td className="py-2 pr-4 font-medium text-gray-900">
                    {u.username}
                    {isSelf && <span className="ml-1 text-xs text-gray-500">(you)</span>}
                  </td>
                  <td className="py-2 pr-4">
                    <select
                      value={u.role}
                      disabled={locked || busy}
                      title={locked ? lockReason : undefined}
                      onChange={(e) => act(u.id, () => api.updateUser(u.id, { role: e.target.value as Role }), `${u.username} is now ${e.target.value}.`)}
                      className="border border-gray-300 rounded-md px-1 py-0.5 disabled:bg-gray-50"
                      aria-label={`Role for ${u.username}`}
                    >
                      <option value="admin">admin</option>
                      <option value="user">user (read-only)</option>
                    </select>
                  </td>
                  <td className="py-2 pr-4">
                    <span className={`px-2 py-0.5 text-xs rounded-full ${u.disabled ? 'bg-gray-200 text-gray-700' : 'bg-green-100 text-green-800'}`}>
                      {u.disabled ? 'disabled' : 'active'}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-gray-600">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}
                  </td>
                  <td className="py-2 space-x-2 whitespace-nowrap">
                    <button
                      className={`${small} border-gray-300 text-gray-700 hover:bg-gray-50`}
                      disabled={locked || busy}
                      title={locked ? lockReason : undefined}
                      onClick={() => act(u.id, () => api.updateUser(u.id, { disabled: !u.disabled }), `${u.username} ${u.disabled ? 'enabled' : 'disabled'}.`)}
                    >
                      {u.disabled ? 'Enable' : 'Disable'}
                    </button>
                    {!isSelf && (
                      <button className={`${small} border-gray-300 text-gray-700 hover:bg-gray-50`} disabled={busy} onClick={() => resetPassword(u)}>
                        Reset password
                      </button>
                    )}
                    {!isSelf && (
                      <button
                        className={`${small} border-gray-300 text-gray-700 hover:bg-gray-50`}
                        disabled={busy}
                        title="End all of this user's sessions now"
                        onClick={() => act(u.id, () => api.revokeUserSessions(u.id), `${u.username} was signed out everywhere.`)}
                      >
                        Sign out
                      </button>
                    )}
                    <button
                      className={`${small} border-red-200 text-red-700 hover:bg-red-50`}
                      disabled={locked || busy}
                      title={locked ? lockReason : undefined}
                      onClick={() => remove(u)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-2 border-t border-gray-100 pt-4">
        <label className="text-sm text-gray-700">
          Username
          <input
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            required
            minLength={3}
            autoComplete="off"
            className="mt-1 block w-40 px-2 py-1 border border-gray-300 rounded-md"
          />
        </label>
        <label className="text-sm text-gray-700">
          Initial password
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
            minLength={8}
            autoComplete="new-password"
            className="mt-1 block w-44 px-2 py-1 border border-gray-300 rounded-md"
          />
        </label>
        <label className="text-sm text-gray-700">
          Role
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
            className="mt-1 block px-2 py-1 border border-gray-300 rounded-md"
          >
            <option value="user">user (read-only)</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busyId === 'new'}
          className="px-3 py-1.5 bg-primary-600 text-white rounded-md text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
        >
          {busyId === 'new' ? 'Adding…' : 'Add user'}
        </button>
      </form>
    </div>
  );
}
