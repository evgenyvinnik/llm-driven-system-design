import { Textarea, Button } from '../ui';

/**
 * Props for the IssueSummaryEditor component.
 */
interface IssueSummaryEditorProps {
  /** The current issue summary */
  summary: string;
  /** The current issue description */
  description: string | null;
  /** Whether the editor is in edit mode */
  isEditing: boolean;
  /** Whether a save operation is in progress */
  isSaving: boolean;
  /** Callback to enter edit mode */
  onStartEdit: () => void;
  /** Callback when summary changes */
  onSummaryChange: (value: string) => void;
  /** Callback when description changes */
  onDescriptionChange: (value: string) => void;
  /** Callback to save changes */
  onSave: () => void;
  /** Callback to cancel editing */
  onCancel: () => void;
}

/**
 * Summary and description editor component.
 *
 * Provides inline editing for the issue summary and description.
 * In view mode, clicking on either field enters edit mode.
 * In edit mode, displays input/textarea fields with save/cancel buttons.
 *
 * @param props - The component props
 * @returns The rendered editor element
 */
export function IssueSummaryEditor({
  summary,
  description,
  isEditing,
  isSaving,
  onStartEdit,
  onSummaryChange,
  onDescriptionChange,
  onSave,
  onCancel,
}: IssueSummaryEditorProps) {
  return (
    <div className="space-y-6">
      {/* Summary */}
      {isEditing ? (
        <input
          type="text"
          value={summary}
          onChange={(e) => onSummaryChange(e.target.value)}
          className="w-full text-2xl font-semibold border-b border-blue-500 focus:outline-none pb-2"
          aria-label="Issue summary"
        />
      ) : (
        <h1
          className="text-2xl font-semibold text-gray-900 cursor-pointer hover:text-blue-600"
          onClick={onStartEdit}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && onStartEdit()}
        >
          {summary}
        </h1>
      )}

      {/* Description */}
      <div>
        <h3 className="text-sm font-medium text-gray-500 mb-2">Description</h3>
        {isEditing ? (
          <Textarea
            value={description || ''}
            onChange={(e) => onDescriptionChange(e.target.value)}
            rows={6}
            placeholder="Add a description..."
          />
        ) : (
          <div
            className="text-gray-700 min-h-[100px] cursor-pointer hover:bg-gray-50 p-2 rounded"
            onClick={onStartEdit}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && onStartEdit()}
          >
            {description || (
              <span className="text-gray-400 italic">Click to add description...</span>
            )}
          </div>
        )}
      </div>

      {/* Edit mode buttons */}
      {isEditing && (
        <div className="flex gap-2">
          <Button variant="primary" onClick={onSave} disabled={isSaving}>
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
