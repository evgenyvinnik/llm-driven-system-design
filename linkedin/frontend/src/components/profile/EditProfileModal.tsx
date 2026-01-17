/**
 * Edit profile modal component for updating user profile information.
 * Provides a form dialog for editing basic profile fields like name,
 * headline, location, industry, and summary.
 *
 * @module components/profile/EditProfileModal
 */
import { X } from 'lucide-react';

/**
 * Form data for editing profile fields.
 * Contains all editable profile fields as optional values.
 */
export interface EditProfileFormData {
  first_name?: string;
  last_name?: string;
  headline?: string;
  summary?: string;
  location?: string;
  industry?: string;
}

/**
 * Props for the EditProfileModal component.
 */
interface EditProfileModalProps {
  /** Whether the modal is currently open */
  isOpen: boolean;
  /** Current form data values */
  formData: EditProfileFormData;
  /** Callback when form data changes */
  onFormDataChange: (data: EditProfileFormData) => void;
  /** Callback when save button is clicked */
  onSave: () => void;
  /** Callback when modal is closed */
  onClose: () => void;
}

/**
 * Modal dialog for editing user profile information.
 * Displays form fields for first name, last name, headline, location,
 * industry, and summary. Supports save and cancel actions.
 *
 * @param props - Component props
 * @returns The modal JSX element or null if not open
 */
export function EditProfileModal({
  isOpen,
  formData,
  onFormDataChange,
  onSave,
  onClose,
}: EditProfileModalProps) {
  if (!isOpen) {
    return null;
  }

  /**
   * Handles changes to form input fields.
   * Updates the form data with the new field value.
   *
   * @param field - The field name to update
   * @param value - The new value for the field
   */
  const handleFieldChange = (field: keyof EditProfileFormData, value: string) => {
    onFormDataChange({ ...formData, [field]: value });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg w-full max-w-lg max-h-[90vh] overflow-y-auto m-4">
        {/* Modal header */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-xl font-semibold">Edit intro</h2>
          <button onClick={onClose} aria-label="Close modal">
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Form fields */}
        <div className="p-4 space-y-4">
          {/* Name fields in a grid */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="first_name" className="block text-sm font-medium mb-1">
                First name
              </label>
              <input
                id="first_name"
                type="text"
                value={formData.first_name || ''}
                onChange={(e) => handleFieldChange('first_name', e.target.value)}
                className="input"
              />
            </div>
            <div>
              <label htmlFor="last_name" className="block text-sm font-medium mb-1">
                Last name
              </label>
              <input
                id="last_name"
                type="text"
                value={formData.last_name || ''}
                onChange={(e) => handleFieldChange('last_name', e.target.value)}
                className="input"
              />
            </div>
          </div>

          {/* Headline field */}
          <div>
            <label htmlFor="headline" className="block text-sm font-medium mb-1">
              Headline
            </label>
            <input
              id="headline"
              type="text"
              value={formData.headline || ''}
              onChange={(e) => handleFieldChange('headline', e.target.value)}
              className="input"
            />
          </div>

          {/* Location field */}
          <div>
            <label htmlFor="location" className="block text-sm font-medium mb-1">
              Location
            </label>
            <input
              id="location"
              type="text"
              value={formData.location || ''}
              onChange={(e) => handleFieldChange('location', e.target.value)}
              className="input"
            />
          </div>

          {/* Industry field */}
          <div>
            <label htmlFor="industry" className="block text-sm font-medium mb-1">
              Industry
            </label>
            <input
              id="industry"
              type="text"
              value={formData.industry || ''}
              onChange={(e) => handleFieldChange('industry', e.target.value)}
              className="input"
            />
          </div>

          {/* Summary/bio field */}
          <div>
            <label htmlFor="summary" className="block text-sm font-medium mb-1">
              Summary
            </label>
            <textarea
              id="summary"
              value={formData.summary || ''}
              onChange={(e) => handleFieldChange('summary', e.target.value)}
              rows={4}
              className="input"
            />
          </div>
        </div>

        {/* Modal footer with action buttons */}
        <div className="p-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button onClick={onSave} className="btn-primary">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
