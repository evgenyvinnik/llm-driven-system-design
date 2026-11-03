import { useState } from 'react';
import type { ProjectSettings as Settings } from '../types';

interface ProjectSettingsProps {
  settings: Settings;
  /** Only owners may change settings; everyone else sees them read-only (the password is never shown). */
  readOnly: boolean;
  onSave: (data: Partial<Settings & { dbPassword?: string }>) => Promise<void>;
}

/** Form for editing project settings including name, description, and database connection details. */
export function ProjectSettings({ settings, readOnly, onSave }: ProjectSettingsProps) {
  const [name, setName] = useState(settings.name);
  const [description, setDescription] = useState(settings.description || '');
  const [dbHost, setDbHost] = useState(settings.dbHost);
  const [dbPort, setDbPort] = useState(String(settings.dbPort));
  const [dbName, setDbName] = useState(settings.dbName);
  const [dbUser, setDbUser] = useState(settings.dbUser);
  const [dbPassword, setDbPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setSuccess(false);
    setError(null);
    try {
      await onSave({
        name,
        description: description || null,
        dbHost,
        dbPort: parseInt(dbPort),
        dbName,
        dbUser,
        ...(dbPassword ? { dbPassword } : {}),
      });
      setSuccess(true);
      setDbPassword('');
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      // e.g. "points at the dashboard's own metadata database", or a validation message
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <fieldset disabled={readOnly} className="space-y-6 disabled:opacity-80">
      {/* General */}
      <div className="bg-supabase-surface border border-supabase-border rounded-lg p-6">
        <h3 className="text-sm font-medium text-supabase-text mb-4">General</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-supabase-secondary mb-1">Project Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-supabase-dark-surface border border-supabase-border rounded px-3 py-2 text-supabase-text text-sm focus:outline-none focus:border-supabase-primary"
            />
          </div>
          <div>
            <label className="block text-sm text-supabase-secondary mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-supabase-dark-surface border border-supabase-border rounded px-3 py-2 text-supabase-text text-sm focus:outline-none focus:border-supabase-primary"
              rows={3}
            />
          </div>
        </div>
      </div>

      {/* Database Connection */}
      <div className="bg-supabase-surface border border-supabase-border rounded-lg p-6">
        <h3 className="text-sm font-medium text-supabase-text mb-4">Database Connection</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-supabase-secondary mb-1">Host</label>
            <input
              type="text"
              value={dbHost}
              onChange={(e) => setDbHost(e.target.value)}
              className="w-full bg-supabase-dark-surface border border-supabase-border rounded px-3 py-2 text-supabase-text text-sm focus:outline-none focus:border-supabase-primary"
            />
          </div>
          <div>
            <label className="block text-sm text-supabase-secondary mb-1">Port</label>
            <input
              type="text"
              value={dbPort}
              onChange={(e) => setDbPort(e.target.value)}
              className="w-full bg-supabase-dark-surface border border-supabase-border rounded px-3 py-2 text-supabase-text text-sm focus:outline-none focus:border-supabase-primary"
            />
          </div>
          <div>
            <label className="block text-sm text-supabase-secondary mb-1">Database</label>
            <input
              type="text"
              value={dbName}
              onChange={(e) => setDbName(e.target.value)}
              className="w-full bg-supabase-dark-surface border border-supabase-border rounded px-3 py-2 text-supabase-text text-sm focus:outline-none focus:border-supabase-primary"
            />
          </div>
          <div>
            <label className="block text-sm text-supabase-secondary mb-1">User</label>
            <input
              type="text"
              value={dbUser}
              onChange={(e) => setDbUser(e.target.value)}
              className="w-full bg-supabase-dark-surface border border-supabase-border rounded px-3 py-2 text-supabase-text text-sm focus:outline-none focus:border-supabase-primary"
            />
          </div>
          <div className="col-span-2">
            <label className="block text-sm text-supabase-secondary mb-1">Password (leave blank to keep current)</label>
            <input
              type="password"
              value={dbPassword}
              onChange={(e) => setDbPassword(e.target.value)}
              className="w-full bg-supabase-dark-surface border border-supabase-border rounded px-3 py-2 text-supabase-text text-sm focus:outline-none focus:border-supabase-primary"
              placeholder="********"
            />
          </div>
        </div>
      </div>

      {/* Save button */}
      {readOnly ? (
        <p className="text-sm text-supabase-secondary">Only project owners can change these settings.</p>
      ) : (
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-supabase-primary hover:bg-supabase-hover text-black px-6 py-2 rounded-md text-sm font-medium disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          {success && (
            <span className="text-supabase-success text-sm">Settings saved</span>
          )}
          {error && <span className="text-red-400 text-sm">{error}</span>}
        </div>
      )}
    </fieldset>
  );
}
