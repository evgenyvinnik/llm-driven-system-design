import React from 'react';
import type { Photo } from '../../types';
import { PhotoItem } from './PhotoItem';
import { LoadingSpinner } from '../common';

/**
 * Props for the PhotoGrid component.
 */
export interface PhotoGridProps {
  /** Array of photos to display */
  photos: Photo[];
  /** Set of selected photo IDs */
  selectedPhotos: Set<string>;
  /** Whether photos are currently loading */
  isLoading: boolean;
  /** Callback when a photo is clicked (for selection toggle) */
  onToggleSelection: (photoId: string) => void;
  /** Callback when a photo is double-clicked (for viewing) */
  onViewPhoto: (index: number) => void;
}

/**
 * Photo grid component displaying thumbnails in a responsive grid.
 *
 * Handles:
 * - Empty state (no photos)
 * - Photo grid with selection and view callbacks
 * - Loading state with spinner
 *
 * Uses the `photo-grid` CSS class for grid layout, which should be
 * defined in the application's global styles.
 *
 * @example
 * ```tsx
 * <PhotoGrid
 *   photos={photos}
 *   selectedPhotos={selectedPhotos}
 *   isLoading={isLoading}
 *   onToggleSelection={(id) => toggleSelection(id)}
 *   onViewPhoto={(index) => setViewingPhotoIndex(index)}
 * />
 * ```
 *
 * @param props - Component props
 * @returns Photo grid with thumbnails or empty/loading state
 */
export const PhotoGrid: React.FC<PhotoGridProps> = ({
  photos,
  selectedPhotos,
  isLoading,
  onToggleSelection,
  onViewPhoto,
}) => {
  if (photos.length === 0 && !isLoading) {
    return <EmptyState />;
  }

  return (
    <>
      <div className="photo-grid">
        {photos.map((photo, index) => (
          <PhotoItem
            key={photo.id}
            photo={photo}
            isSelected={selectedPhotos.has(photo.id)}
            onSelect={() => onToggleSelection(photo.id)}
            onView={() => onViewPhoto(index)}
          />
        ))}
      </div>

      {isLoading && (
        <div className="flex justify-center py-8">
          <LoadingSpinner />
        </div>
      )}
    </>
  );
};

/**
 * Empty state displayed when there are no photos.
 *
 * Shows an icon and helpful text encouraging the user to upload photos.
 *
 * @returns Empty state message with icon
 */
const EmptyState: React.FC = () => (
  <div className="flex flex-col items-center justify-center h-64 text-gray-500">
    <svg className="w-16 h-16 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1}
        d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
      />
    </svg>
    <p>No photos yet</p>
    <p className="text-sm">Upload some photos to get started</p>
  </div>
);
