import { useState } from 'react';

interface MessageEditorProps {
  initial: string;
  onSave: (content: string) => Promise<void>;
  onCancel: () => void;
}

/** Inline editor for your own message: Enter saves, Escape cancels. */
export function MessageEditor({ initial, onSave, onCancel }: MessageEditorProps) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    const content = value.trim();
    if (!content || saving) return;
    if (content === initial) {
      onCancel();
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(content);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
      setSaving(false);
    }
  };

  return (
    <div className="mt-1">
      <textarea
        data-testid="message-editor"
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            onCancel();
          }
        }}
        rows={2}
        className="w-full border border-teams-border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-teams-primary"
      />
      <div className="flex items-center gap-2 text-xs mt-1">
        <button
          onClick={save}
          disabled={saving || !value.trim()}
          className="px-2 py-1 bg-teams-primary text-white rounded disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button onClick={onCancel} className="px-2 py-1 text-teams-secondary hover:text-teams-text">
          Cancel
        </button>
        {error && <span className="text-teams-danger">{error}</span>}
      </div>
    </div>
  );
}
