import React from 'react';

/**
 * Props for the SelectionBar component.
 */
export interface SelectionBarProps {
  /** Number of currently selected items */
  selectedCount: number;
  /** Callback when "Clear selection" is clicked */
  onClearSelection: () => void;
}

/**
 * Selection status bar shown when files are selected.
 *
 * Displays the number of selected items and a button to clear the selection.
 * Returns null if no items are selected.
 *
 * @example
 * ```tsx
 * <SelectionBar
 *   selectedCount={selectedFiles.size}
 *   onClearSelection={clearSelection}
 * />
 * ```
 *
 * @param props - Component props
 * @returns Selection bar or null if nothing selected
 */
export const SelectionBar: React.FC<SelectionBarProps> = ({
  selectedCount,
  onClearSelection,
}) => {
  if (selectedCount === 0) return null;

  return (
    <div className="p-4 border-t bg-gray-50 flex items-center justify-between">
      <span className="text-sm text-gray-600">{selectedCount} item(s) selected</span>
      <button
        className="text-sm text-gray-500 hover:text-gray-700"
        onClick={onClearSelection}
      >
        Clear selection
      </button>
    </div>
  );
};
