import React from 'react';

/**
 * Props for the PhotoToolbar component.
 */
export interface PhotoToolbarProps {
  /** Current filter mode */
  filter: 'all' | 'favorites';
  /** Callback when filter changes */
  onFilterChange: (filter: 'all' | 'favorites') => void;
  /** Number of currently selected photos */
  selectedCount: number;
  /** Callback when "Create Album" is clicked */
  onCreateAlbum: () => void;
  /** Callback when "Clear" selection is clicked */
  onClearSelection: () => void;
  /** Callback when files are selected for upload */
  onUpload: (files: File[]) => void;
}

/**
 * Toolbar for the photo gallery.
 *
 * Provides controls for:
 * - Title display
 * - Filter toggle (All / Favorites)
 * - Selection actions (when photos are selected):
 *   - Create Album button
 *   - Clear selection button
 * - Upload button (file input)
 *
 * @example
 * ```tsx
 * <PhotoToolbar
 *   filter={filter}
 *   onFilterChange={setFilter}
 *   selectedCount={selectedPhotos.size}
 *   onCreateAlbum={() => setShowCreateAlbum(true)}
 *   onClearSelection={clearSelection}
 *   onUpload={uploadPhotos}
 * />
 * ```
 *
 * @param props - Component props
 * @returns Toolbar with filter, selection actions, and upload
 */
export const PhotoToolbar: React.FC<PhotoToolbarProps> = ({
  filter,
  onFilterChange,
  selectedCount,
  onCreateAlbum,
  onClearSelection,
  onUpload,
}) => {
  /**
   * Handles file input change event.
   * Filters to only include image files.
   */
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter((f) =>
      f.type.startsWith('image/')
    );
    if (files.length > 0) {
      onUpload(files);
    }
    // Reset input so same file can be selected again
    e.target.value = '';
  };

  return (
    <div className="flex items-center justify-between p-4 border-b">
      <div className="flex items-center gap-4">
        <h2 className="text-xl font-semibold">Photos</h2>
        <FilterToggle filter={filter} onFilterChange={onFilterChange} />
      </div>

      <div className="flex items-center gap-2">
        {selectedCount > 0 && (
          <SelectionActions
            selectedCount={selectedCount}
            onCreateAlbum={onCreateAlbum}
            onClearSelection={onClearSelection}
          />
        )}

        <label className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 cursor-pointer">
          Upload
          <input
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />
        </label>
      </div>
    </div>
  );
};

/**
 * Props for the FilterToggle component.
 */
interface FilterToggleProps {
  filter: 'all' | 'favorites';
  onFilterChange: (filter: 'all' | 'favorites') => void;
}

/**
 * Toggle button group for filtering photos.
 *
 * @param props - Component props
 * @returns Toggle button group
 */
const FilterToggle: React.FC<FilterToggleProps> = ({ filter, onFilterChange }) => (
  <div className="flex bg-gray-100 rounded-lg p-1">
    <button
      className={`px-3 py-1 text-sm rounded ${filter === 'all' ? 'bg-white shadow' : ''}`}
      onClick={() => onFilterChange('all')}
    >
      All
    </button>
    <button
      className={`px-3 py-1 text-sm rounded ${filter === 'favorites' ? 'bg-white shadow' : ''}`}
      onClick={() => onFilterChange('favorites')}
    >
      Favorites
    </button>
  </div>
);

/**
 * Props for the SelectionActions component.
 */
interface SelectionActionsProps {
  selectedCount: number;
  onCreateAlbum: () => void;
  onClearSelection: () => void;
}

/**
 * Action buttons shown when photos are selected.
 *
 * @param props - Component props
 * @returns Selection count and action buttons
 */
const SelectionActions: React.FC<SelectionActionsProps> = ({
  selectedCount,
  onCreateAlbum,
  onClearSelection,
}) => (
  <>
    <span className="text-sm text-gray-500">{selectedCount} selected</span>
    <button
      className="px-3 py-1.5 text-sm bg-gray-100 rounded hover:bg-gray-200"
      onClick={onCreateAlbum}
    >
      Create Album
    </button>
    <button
      className="text-sm text-gray-500 hover:text-gray-700"
      onClick={onClearSelection}
    >
      Clear
    </button>
  </>
);
