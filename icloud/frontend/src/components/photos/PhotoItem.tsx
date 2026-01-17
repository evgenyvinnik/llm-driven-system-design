import React from 'react';
import type { Photo } from '../../types';

/**
 * Props for the PhotoItem component.
 */
export interface PhotoItemProps {
  /** Photo to display */
  photo: Photo;
  /** Whether this photo is currently selected */
  isSelected: boolean;
  /** Callback when photo is clicked (for selection) */
  onSelect: () => void;
  /** Callback when photo is double-clicked (for viewing) */
  onView: () => void;
}

/**
 * Renders a single photo thumbnail in the gallery grid.
 *
 * Displays the photo thumbnail with a favorite indicator (heart icon)
 * and selection state. Supports lazy loading for performance with large galleries.
 *
 * Uses the `photo-item` and `selected` CSS classes for styling, which should
 * be defined in the application's global styles.
 *
 * @example
 * ```tsx
 * <PhotoItem
 *   photo={photo}
 *   isSelected={selectedPhotos.has(photo.id)}
 *   onSelect={() => toggleSelection(photo.id)}
 *   onView={() => setViewingPhoto(photo)}
 * />
 * ```
 *
 * @param props - Component props
 * @returns Photo thumbnail element with favorite indicator
 */
export const PhotoItem: React.FC<PhotoItemProps> = ({
  photo,
  isSelected,
  onSelect,
  onView,
}) => {
  return (
    <div
      className={`photo-item ${isSelected ? 'selected' : ''}`}
      onClick={onSelect}
      onDoubleClick={onView}
    >
      <img src={photo.thumbnailUrl} alt="" loading="lazy" />
      {photo.isFavorite && (
        <div className="absolute top-2 right-2 text-white drop-shadow">
          <svg className="w-5 h-5 fill-current" viewBox="0 0 20 20">
            <path d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" />
          </svg>
        </div>
      )}
    </div>
  );
};
