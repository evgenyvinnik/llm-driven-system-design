import { useState } from 'react';
import { activitiesApi } from '../services/api';
import { ACTIVITY_TYPES } from '../types';

interface ActivityFormProps {
  relatedType?: string;
  relatedId?: string;
  onSaved: () => void;
  onCancel: () => void;
}

/** Renders an inline form for logging a new activity (call, email, meeting, note) on an entity. */
export function ActivityForm({ relatedType, relatedId, onSaved, onCancel }: ActivityFormProps) {
  const [type, setType] = useState('call');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      await activitiesApi.create({
        type,
        subject,
        description: description || undefined,
        // datetime-local has no zone; send an ISO instant so the server doesn't
        // read the user's local time as its own (UTC) time.
        dueDate: dueDate ? new Date(dueDate).toISOString() : undefined,
        relatedType,
        relatedId,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create activity');
    }
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="bg-gray-50 rounded-lg p-4 mb-4 space-y-3">
      {error && (
        <div className="bg-red-50 text-red-600 px-3 py-2 rounded text-sm">{error}</div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-salesforce-secondary mb-1">Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="w-full px-3 py-2 border border-salesforce-border rounded text-sm"
          >
            {ACTIVITY_TYPES.map((t) => (
              <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-salesforce-secondary mb-1">Due Date</label>
          <input
            type="datetime-local"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full px-3 py-2 border border-salesforce-border rounded text-sm"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-salesforce-secondary mb-1">Subject</label>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Activity subject"
          required
          className="w-full px-3 py-2 border border-salesforce-border rounded text-sm"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-salesforce-secondary mb-1">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional description..."
          rows={2}
          className="w-full px-3 py-2 border border-salesforce-border rounded text-sm resize-none"
        />
      </div>

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 border border-salesforce-border rounded text-sm hover:bg-gray-100"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="px-3 py-1.5 bg-salesforce-primary text-white rounded text-sm hover:bg-salesforce-hover disabled:opacity-50"
        >
          {submitting ? 'Saving...' : 'Save Activity'}
        </button>
      </div>
    </form>
  );
}
