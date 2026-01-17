import React from 'react';

/**
 * Props for the DragOverlay component.
 */
export interface DragOverlayProps {
  /** Whether to show the overlay */
  isVisible: boolean;
}

/**
 * Drag-and-drop overlay displayed when files are dragged over the browser.
 *
 * Shows a visual indicator to the user that they can drop files to upload.
 * Returns null when not visible.
 *
 * @example
 * ```tsx
 * <DragOverlay isVisible={isDragOver} />
 * ```
 *
 * @param props - Component props
 * @returns Drag overlay or null
 */
export const DragOverlay: React.FC<DragOverlayProps> = ({ isVisible }) => {
  if (!isVisible) return null;

  return (
    <div className="absolute inset-0 bg-blue-500 bg-opacity-20 flex items-center justify-center pointer-events-none">
      <div className="text-blue-600 text-lg font-medium">Drop files to upload</div>
    </div>
  );
};
