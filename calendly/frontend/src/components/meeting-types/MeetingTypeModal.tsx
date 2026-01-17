import { useState, useEffect } from 'react';
import type { MeetingType } from '../../types';
import { meetingTypesApi } from '../../services/api';

/**
 * Props for the MeetingTypeModal component.
 */
export interface MeetingTypeModalProps {
  /** The meeting type to edit, or null for creating a new one */
  type: MeetingType | null;
  /** Callback fired when the modal should close */
  onClose: () => void;
  /** Callback fired when a meeting type is successfully saved */
  onSave: (type: MeetingType) => void;
}

/**
 * Modal dialog for creating or editing a meeting type.
 * Provides form fields for all meeting type configuration options
 * including name, slug, description, duration, buffers, and color.
 *
 * @param props - Component props
 */
export function MeetingTypeModal({ type, onClose, onSave }: MeetingTypeModalProps) {
  const [name, setName] = useState(type?.name || '');
  const [slug, setSlug] = useState(type?.slug || '');
  const [description, setDescription] = useState(type?.description || '');
  const [duration, setDuration] = useState(type?.duration_minutes || 30);
  const [bufferBefore, setBufferBefore] = useState(type?.buffer_before_minutes || 0);
  const [bufferAfter, setBufferAfter] = useState(type?.buffer_after_minutes || 0);
  const [color, setColor] = useState(type?.color || '#3B82F6');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  /**
   * Auto-generates a URL-friendly slug from the name.
   * Only runs for new meeting types (not when editing).
   */
  useEffect(() => {
    if (!type) {
      setSlug(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
    }
  }, [name, type]);

  /**
   * Handles form submission.
   * Creates a new meeting type or updates an existing one.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const data = {
        name,
        slug,
        description: description || undefined,
        duration_minutes: duration,
        buffer_before_minutes: bufferBefore,
        buffer_after_minutes: bufferAfter,
        color,
      };

      const response = type
        ? await meetingTypesApi.update(type.id, data)
        : await meetingTypesApi.create(data);

      if (response.success && response.data) {
        onSave(response.data);
      } else {
        setError(response.error || 'Failed to save event type');
      }
    } catch (err) {
      setError('An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-4">
            {type ? 'Edit Event Type' : 'New Event Type'}
          </h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
                {error}
              </div>
            )}

            <MeetingTypeNameField name={name} setName={setName} />
            <MeetingTypeSlugField slug={slug} setSlug={setSlug} />
            <MeetingTypeDescriptionField description={description} setDescription={setDescription} />
            <MeetingTypeDurationFields
              duration={duration}
              setDuration={setDuration}
              bufferBefore={bufferBefore}
              setBufferBefore={setBufferBefore}
              bufferAfter={bufferAfter}
              setBufferAfter={setBufferAfter}
            />
            <MeetingTypeColorField color={color} setColor={setColor} />
            <MeetingTypeFormActions
              isLoading={isLoading}
              isEditing={!!type}
              onClose={onClose}
            />
          </form>
        </div>
      </div>
    </div>
  );
}

/**
 * Props for the MeetingTypeNameField component.
 */
interface MeetingTypeNameFieldProps {
  /** Current name value */
  name: string;
  /** Callback to update the name value */
  setName: (value: string) => void;
}

/**
 * Form field for the meeting type name.
 *
 * @param props - Component props
 */
function MeetingTypeNameField({ name, setName }: MeetingTypeNameFieldProps) {
  return (
    <div>
      <label htmlFor="name" className="label">Event Name</label>
      <input
        id="name"
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="input"
        required
        placeholder="e.g., 30 Minute Meeting"
      />
    </div>
  );
}

/**
 * Props for the MeetingTypeSlugField component.
 */
interface MeetingTypeSlugFieldProps {
  /** Current slug value */
  slug: string;
  /** Callback to update the slug value */
  setSlug: (value: string) => void;
}

/**
 * Form field for the meeting type URL slug.
 *
 * @param props - Component props
 */
function MeetingTypeSlugField({ slug, setSlug }: MeetingTypeSlugFieldProps) {
  return (
    <div>
      <label htmlFor="slug" className="label">URL Slug</label>
      <input
        id="slug"
        type="text"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
        className="input"
        required
        pattern="[a-z0-9-]+"
        placeholder="e.g., 30-minute-meeting"
      />
      <p className="text-xs text-gray-500 mt-1">Lowercase letters, numbers, and hyphens only</p>
    </div>
  );
}

/**
 * Props for the MeetingTypeDescriptionField component.
 */
interface MeetingTypeDescriptionFieldProps {
  /** Current description value */
  description: string;
  /** Callback to update the description value */
  setDescription: (value: string) => void;
}

/**
 * Form field for the meeting type description.
 *
 * @param props - Component props
 */
function MeetingTypeDescriptionField({ description, setDescription }: MeetingTypeDescriptionFieldProps) {
  return (
    <div>
      <label htmlFor="description" className="label">Description (optional)</label>
      <textarea
        id="description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="input"
        rows={3}
        placeholder="Brief description of this meeting type"
      />
    </div>
  );
}

/**
 * Props for the MeetingTypeDurationFields component.
 */
interface MeetingTypeDurationFieldsProps {
  /** Meeting duration in minutes */
  duration: number;
  /** Callback to update duration */
  setDuration: (value: number) => void;
  /** Buffer before meeting in minutes */
  bufferBefore: number;
  /** Callback to update buffer before */
  setBufferBefore: (value: number) => void;
  /** Buffer after meeting in minutes */
  bufferAfter: number;
  /** Callback to update buffer after */
  setBufferAfter: (value: number) => void;
}

/**
 * Form fields for duration and buffer times.
 * Displays three select dropdowns in a grid layout.
 *
 * @param props - Component props
 */
function MeetingTypeDurationFields({
  duration,
  setDuration,
  bufferBefore,
  setBufferBefore,
  bufferAfter,
  setBufferAfter,
}: MeetingTypeDurationFieldsProps) {
  return (
    <div className="grid grid-cols-3 gap-4">
      <div>
        <label htmlFor="duration" className="label">Duration (min)</label>
        <select
          id="duration"
          value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
          className="input"
        >
          <option value={15}>15</option>
          <option value={30}>30</option>
          <option value={45}>45</option>
          <option value={60}>60</option>
          <option value={90}>90</option>
          <option value={120}>120</option>
        </select>
      </div>

      <div>
        <label htmlFor="bufferBefore" className="label">Buffer Before</label>
        <select
          id="bufferBefore"
          value={bufferBefore}
          onChange={(e) => setBufferBefore(Number(e.target.value))}
          className="input"
        >
          <option value={0}>None</option>
          <option value={5}>5 min</option>
          <option value={10}>10 min</option>
          <option value={15}>15 min</option>
          <option value={30}>30 min</option>
        </select>
      </div>

      <div>
        <label htmlFor="bufferAfter" className="label">Buffer After</label>
        <select
          id="bufferAfter"
          value={bufferAfter}
          onChange={(e) => setBufferAfter(Number(e.target.value))}
          className="input"
        >
          <option value={0}>None</option>
          <option value={5}>5 min</option>
          <option value={10}>10 min</option>
          <option value={15}>15 min</option>
          <option value={30}>30 min</option>
        </select>
      </div>
    </div>
  );
}

/**
 * Props for the MeetingTypeColorField component.
 */
interface MeetingTypeColorFieldProps {
  /** Current color value (hex format) */
  color: string;
  /** Callback to update the color value */
  setColor: (value: string) => void;
}

/**
 * Form field for the meeting type color.
 * Uses a native color picker input.
 *
 * @param props - Component props
 */
function MeetingTypeColorField({ color, setColor }: MeetingTypeColorFieldProps) {
  return (
    <div>
      <label htmlFor="color" className="label">Color</label>
      <input
        id="color"
        type="color"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        className="w-full h-10 rounded-lg cursor-pointer"
      />
    </div>
  );
}

/**
 * Props for the MeetingTypeFormActions component.
 */
interface MeetingTypeFormActionsProps {
  /** Whether the form is currently submitting */
  isLoading: boolean;
  /** Whether this is an edit (true) or create (false) operation */
  isEditing: boolean;
  /** Callback to close the modal */
  onClose: () => void;
}

/**
 * Form action buttons (Cancel and Submit).
 *
 * @param props - Component props
 */
function MeetingTypeFormActions({ isLoading, isEditing, onClose }: MeetingTypeFormActionsProps) {
  return (
    <div className="flex justify-end space-x-3 pt-4">
      <button
        type="button"
        onClick={onClose}
        className="btn btn-secondary"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={isLoading}
        className="btn btn-primary"
      >
        {isLoading ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Event Type'}
      </button>
    </div>
  );
}
