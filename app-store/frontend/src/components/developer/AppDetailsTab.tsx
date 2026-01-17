/**
 * @fileoverview App details tab component for developer dashboard.
 * Displays app information in view mode or edit form.
 */

import type { App } from '../../types';

/**
 * Props for the AppDetailsTab component.
 */
interface AppDetailsTabProps {
  /** App data to display */
  app: App;
  /** Whether the form is in edit mode */
  isEditing: boolean;
  /** Current edit form data */
  editData: Partial<App>;
  /** Callback when edit data changes */
  onEditDataChange: (data: Partial<App>) => void;
  /** Callback to cancel editing */
  onCancel: () => void;
  /** Callback to save changes */
  onSave: () => void;
}

/**
 * Displays app details in view mode or an editable form.
 * Provides fields for name, description, release notes, and version.
 *
 * @param props - Component props
 * @returns Details tab content with view or edit mode
 */
export function AppDetailsTab({
  app,
  isEditing,
  editData,
  onEditDataChange,
  onCancel,
  onSave,
}: AppDetailsTabProps) {
  /**
   * Updates a single field in the edit data.
   * @param field - Field name to update
   * @param value - New value for the field
   */
  const updateField = (field: keyof App, value: string) => {
    onEditDataChange({ ...editData, [field]: value });
  };

  if (isEditing) {
    return (
      <div className="card p-6">
        <AppEditForm
          editData={editData}
          onFieldChange={updateField}
          onCancel={onCancel}
          onSave={onSave}
        />
      </div>
    );
  }

  return (
    <div className="card p-6">
      <AppDetailsView app={app} />
    </div>
  );
}

/**
 * Props for the AppEditForm component.
 */
interface AppEditFormProps {
  /** Current form data */
  editData: Partial<App>;
  /** Callback when a field value changes */
  onFieldChange: (field: keyof App, value: string) => void;
  /** Callback to cancel editing */
  onCancel: () => void;
  /** Callback to save changes */
  onSave: () => void;
}

/**
 * Edit form for app metadata.
 * Contains form fields for app name, descriptions, release notes, and version.
 *
 * @param props - Component props
 * @returns Editable form with save/cancel actions
 */
function AppEditForm({
  editData,
  onFieldChange,
  onCancel,
  onSave,
}: AppEditFormProps) {
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          App Name
        </label>
        <input
          type="text"
          value={editData.name || ''}
          onChange={(e) => onFieldChange('name', e.target.value)}
          className="input"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Short Description
        </label>
        <input
          type="text"
          value={editData.shortDescription || ''}
          onChange={(e) => onFieldChange('shortDescription', e.target.value)}
          className="input"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Description
        </label>
        <textarea
          value={editData.description || ''}
          onChange={(e) => onFieldChange('description', e.target.value)}
          className="input min-h-[150px]"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Release Notes
        </label>
        <textarea
          value={editData.releaseNotes || ''}
          onChange={(e) => onFieldChange('releaseNotes', e.target.value)}
          className="input min-h-[100px]"
          placeholder="What's new in this version?"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Version
        </label>
        <input
          type="text"
          value={editData.version || ''}
          onChange={(e) => onFieldChange('version', e.target.value)}
          className="input"
          placeholder="1.0.0"
        />
      </div>

      <div className="flex gap-3 pt-4">
        <button onClick={onCancel} className="btn btn-secondary">
          Cancel
        </button>
        <button onClick={onSave} className="btn btn-primary">
          Save Changes
        </button>
      </div>
    </div>
  );
}

/**
 * Props for the AppDetailsView component.
 */
interface AppDetailsViewProps {
  /** App data to display */
  app: App;
}

/**
 * Read-only view of app details.
 * Displays description, release notes, and keywords.
 *
 * @param props - Component props
 * @returns Details view with app information
 */
function AppDetailsView({ app }: AppDetailsViewProps) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-gray-500 mb-1">Description</h3>
        <p className="text-gray-900 whitespace-pre-line">{app.description}</p>
      </div>

      {app.releaseNotes && (
        <div>
          <h3 className="text-sm font-medium text-gray-500 mb-1">
            Release Notes
          </h3>
          <p className="text-gray-900">{app.releaseNotes}</p>
        </div>
      )}

      {app.keywords && app.keywords.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-500 mb-2">Keywords</h3>
          <div className="flex flex-wrap gap-2">
            {app.keywords.map((keyword, i) => (
              <span
                key={i}
                className="px-2 py-1 bg-gray-100 text-gray-600 rounded-full text-sm"
              >
                {keyword}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
