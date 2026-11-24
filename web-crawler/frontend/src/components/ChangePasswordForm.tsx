/**
 * @fileoverview Change your own password (any signed-in user).
 *
 * The server re-issues this session and revokes all others, so the user stays
 * signed in here while any other device is signed out.
 *
 * @module components/ChangePasswordForm
 */

import { useState, type FormEvent } from 'react';
import { api } from '../services/api';

export function ChangePasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const signOutOthers = async () => {
    setSigningOut(true);
    setMessage(null);
    try {
      setMessage({ text: (await api.logoutOthers()).message, ok: true });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Failed', ok: false });
    } finally {
      setSigningOut(false);
    }
  };

  const mismatch = confirm.length > 0 && next !== confirm;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.changePassword(current, next);
      setMessage({ text: res.message, ok: true });
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Password change failed', ok: false });
    } finally {
      setBusy(false);
    }
  };

  const input = 'mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm';

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 space-y-3">
      <h2 className="text-lg font-medium text-gray-900">Your account</h2>
      <label className="block text-sm text-gray-700">
        Current password
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required className={input} />
      </label>
      <label className="block text-sm text-gray-700">
        New password (at least 8 characters)
        <input type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required className={input} />
      </label>
      <label className="block text-sm text-gray-700">
        Confirm new password
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required className={input} aria-invalid={mismatch} />
      </label>
      {mismatch && <p className="text-sm text-amber-800">Passwords don't match.</p>}
      {message && (
        <p role={message.ok ? 'status' : 'alert'} className={`text-sm ${message.ok ? 'text-green-700' : 'text-red-700'}`}>
          {message.text}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy || mismatch || next.length < 8}
          className="px-4 py-2 bg-primary-600 text-white rounded-md text-sm font-medium hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? 'Saving…' : 'Change password'}
        </button>
        <button
          type="button"
          onClick={signOutOthers}
          disabled={signingOut}
          title="End every session of yours except this one (e.g. a forgotten laptop)"
          className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md text-sm hover:bg-gray-50 disabled:opacity-50"
        >
          {signingOut ? 'Signing out…' : 'Sign out other sessions'}
        </button>
      </div>
    </form>
  );
}
