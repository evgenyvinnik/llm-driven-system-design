import { useState } from 'react';
import { OPPORTUNITY_STAGES, LEAD_SOURCES } from '../types';

interface EntityFormProps {
  entityType: 'account' | 'contact' | 'opportunity' | 'lead';
  onSave: (data: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
  accounts?: { id: string; name: string }[];
}

/** Renders a polymorphic modal form for creating accounts, contacts, opportunities, or leads. */
export function EntityForm({ entityType, onSave, onCancel, accounts }: EntityFormProps) {
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      await onSave(formData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-salesforce-text mb-4">
          New {entityType.charAt(0).toUpperCase() + entityType.slice(1)}
        </h3>

        {error && (
          <div className="bg-red-50 text-red-600 px-3 py-2 rounded text-sm mb-4">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          {entityType === 'account' && (
            <>
              <FormField label="Name *" value={formData.name} onChange={(v) => handleChange('name', v)} required />
              <FormField label="Industry" value={formData.industry} onChange={(v) => handleChange('industry', v)} />
              <FormField label="Website" value={formData.website} onChange={(v) => handleChange('website', v)} />
              <FormField label="Phone" value={formData.phone} onChange={(v) => handleChange('phone', v)} />
              <FormField label="Street" value={formData.addressStreet} onChange={(v) => handleChange('addressStreet', v)} />
              <div className="grid grid-cols-2 gap-3">
                <FormField label="City" value={formData.addressCity} onChange={(v) => handleChange('addressCity', v)} />
                <FormField label="State" value={formData.addressState} onChange={(v) => handleChange('addressState', v)} />
              </div>
              <FormField label="Country" value={formData.addressCountry} onChange={(v) => handleChange('addressCountry', v)} />
              <FormField label="Employees" value={formData.employeeCount} onChange={(v) => handleChange('employeeCount', v)} type="number" />
            </>
          )}

          {entityType === 'contact' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="First Name *" value={formData.firstName} onChange={(v) => handleChange('firstName', v)} required />
                <FormField label="Last Name *" value={formData.lastName} onChange={(v) => handleChange('lastName', v)} required />
              </div>
              <FormField label="Email" value={formData.email} onChange={(v) => handleChange('email', v)} type="email" />
              <FormField label="Phone" value={formData.phone} onChange={(v) => handleChange('phone', v)} />
              <FormField label="Title" value={formData.title} onChange={(v) => handleChange('title', v)} />
              <FormField label="Department" value={formData.department} onChange={(v) => handleChange('department', v)} />
              {accounts && (
                <div>
                  <label className="block text-xs font-medium text-salesforce-secondary mb-1">Account</label>
                  <select
                    value={formData.accountId || ''}
                    onChange={(e) => handleChange('accountId', e.target.value)}
                    className="w-full px-3 py-2 border border-salesforce-border rounded text-sm"
                  >
                    <option value="">-- None --</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}

          {entityType === 'opportunity' && (
            <>
              <FormField label="Name *" value={formData.name} onChange={(v) => handleChange('name', v)} required />
              <FormField label="Amount ($)" value={formData.amount} onChange={(v) => handleChange('amount', v)} type="number" placeholder="e.g. 125000" />
              <div>
                <label className="block text-xs font-medium text-salesforce-secondary mb-1">Stage</label>
                <select
                  value={formData.stage || 'Prospecting'}
                  onChange={(e) => handleChange('stage', e.target.value)}
                  className="w-full px-3 py-2 border border-salesforce-border rounded text-sm"
                >
                  {OPPORTUNITY_STAGES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <FormField label="Close Date" value={formData.closeDate} onChange={(v) => handleChange('closeDate', v)} type="date" />
              <FormField label="Description" value={formData.description} onChange={(v) => handleChange('description', v)} />
              {accounts && (
                <div>
                  <label className="block text-xs font-medium text-salesforce-secondary mb-1">Account</label>
                  <select
                    value={formData.accountId || ''}
                    onChange={(e) => handleChange('accountId', e.target.value)}
                    className="w-full px-3 py-2 border border-salesforce-border rounded text-sm"
                  >
                    <option value="">-- None --</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}

          {entityType === 'lead' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="First Name *" value={formData.firstName} onChange={(v) => handleChange('firstName', v)} required />
                <FormField label="Last Name *" value={formData.lastName} onChange={(v) => handleChange('lastName', v)} required />
              </div>
              <FormField label="Email" value={formData.email} onChange={(v) => handleChange('email', v)} type="email" />
              <FormField label="Phone" value={formData.phone} onChange={(v) => handleChange('phone', v)} />
              <FormField label="Company" value={formData.company} onChange={(v) => handleChange('company', v)} />
              <FormField label="Title" value={formData.title} onChange={(v) => handleChange('title', v)} />
              <div>
                <label className="block text-xs font-medium text-salesforce-secondary mb-1">Source</label>
                <select
                  value={formData.source || ''}
                  onChange={(e) => handleChange('source', e.target.value)}
                  className="w-full px-3 py-2 border border-salesforce-border rounded text-sm"
                >
                  <option value="">-- Select --</option>
                  {LEAD_SOURCES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 border border-salesforce-border rounded-lg text-sm hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 bg-salesforce-primary text-white rounded-lg text-sm hover:bg-salesforce-hover disabled:opacity-50"
            >
              {submitting ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function FormField({
  label, value, onChange, required, type = 'text', placeholder,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string) => void;
  required?: boolean;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-salesforce-secondary mb-1">{label}</label>
      <input
        type={type}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-salesforce-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-salesforce-primary"
      />
    </div>
  );
}
