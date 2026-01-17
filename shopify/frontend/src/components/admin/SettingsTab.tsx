import { useState } from 'react';
import { storesApi } from '../../services/api';
import { Store } from '../../types';

/**
 * Props for SettingsTab component.
 */
interface SettingsTabProps {
  /** Current store data */
  store: Store;
  /** Callback to update store in parent state */
  setStore: (store: Store) => void;
}

/**
 * Settings tab component.
 * Allows editing store settings like name, description, and currency.
 *
 * @param props - Settings tab configuration
 * @returns Store settings form
 */
export function SettingsTab({ store, setStore }: SettingsTabProps) {
  const [formData, setFormData] = useState({
    name: store.name,
    description: store.description || '',
    currency: store.currency,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  /**
   * Handles form submission to save store settings.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { store: updatedStore } = await storesApi.update(store.id, formData);
      setStore(updatedStore);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      console.error('Failed to update store:', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <StoreSettingsForm
        formData={formData}
        setFormData={setFormData}
        onSubmit={handleSubmit}
        saving={saving}
        saved={saved}
      />

      <StoreUrlsInfo store={store} />
    </div>
  );
}

/**
 * Store settings form component.
 */
interface StoreSettingsFormProps {
  formData: {
    name: string;
    description: string;
    currency: string;
  };
  setFormData: (data: { name: string; description: string; currency: string }) => void;
  onSubmit: (e: React.FormEvent) => void;
  saving: boolean;
  saved: boolean;
}

function StoreSettingsForm({ formData, setFormData, onSubmit, saving, saved }: StoreSettingsFormProps) {
  return (
    <div className="bg-white rounded-xl shadow-sm p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-6">Store Settings</h3>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Store Name</label>
          <input
            type="text"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <textarea
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
            rows={3}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
          <select
            value={formData.currency}
            onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
          >
            <option value="USD">USD - US Dollar</option>
            <option value="EUR">EUR - Euro</option>
            <option value="GBP">GBP - British Pound</option>
            <option value="CAD">CAD - Canadian Dollar</option>
          </select>
        </div>
        <div className="pt-4">
          <button
            type="submit"
            disabled={saving}
            className="bg-indigo-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Store URLs info section.
 */
interface StoreUrlsInfoProps {
  store: Store;
}

function StoreUrlsInfo({ store }: StoreUrlsInfoProps) {
  return (
    <div className="bg-white rounded-xl shadow-sm p-6 mt-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Store URLs</h3>
      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-500">Subdomain</label>
          <p className="text-gray-900">{store.subdomain}.shopify.local</p>
        </div>
        {store.custom_domain && (
          <div>
            <label className="block text-sm font-medium text-gray-500">Custom Domain</label>
            <p className="text-gray-900">{store.custom_domain}</p>
          </div>
        )}
      </div>
    </div>
  );
}
