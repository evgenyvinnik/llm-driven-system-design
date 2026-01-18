import React, { useRef, useCallback, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
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
  /** Whether there are more photos to load */
  hasMore?: boolean;
  /** Callback to load more photos */
  onLoadMore?: () => void;
  /** Callback when a photo is clicked (for selection toggle) */
  onToggleSelection: (photoId: string) => void;
  /** Callback when a photo is double-clicked (for viewing) */
  onViewPhoto: (index: number) => void;
}

// Number of columns in the grid (responsive would need ResizeObserver)
const COLUMNS = 4;
const ITEM_HEIGHT = 200; // Height of each row including gap

/**
 * Virtualized photo grid component displaying thumbnails in a responsive grid.
 *
 * Uses @tanstack/react-virtual for efficient rendering of large photo collections.
 * Only renders photos currently visible in the viewport plus a small overscan.
 *
 * @param props - Component props
 * @returns Photo grid with thumbnails or empty/loading state
 */
export const PhotoGrid: React.FC<PhotoGridProps> = ({
  photos,
  selectedPhotos,
  isLoading,
  hasMore,
  onLoadMore,
  onToggleSelection,
  onViewPhoto,
}) => {
  const parentRef = useRef<HTMLDivElement>(null);

  // Calculate number of rows needed
  const rowCount = Math.ceil(photos.length / COLUMNS);

  // Virtual list for rows
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ITEM_HEIGHT,
    overscan: 2, // Render 2 extra rows above/below
  });

  // Infinite scroll handler
  const handleScroll = useCallback(() => {
    if (!parentRef.current || isLoading || !hasMore || !onLoadMore) return;

    const { scrollTop, scrollHeight, clientHeight } = parentRef.current;
    if (scrollHeight - scrollTop - clientHeight < 300) {
      onLoadMore();
    }
  }, [isLoading, hasMore, onLoadMore]);

  useEffect(() => {
    const parent = parentRef.current;
    if (parent) {
      parent.addEventListener('scroll', handleScroll);
      return () => parent.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll]);

  if (photos.length === 0 && !isLoading) {
    return <EmptyState />;
  }

  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      className="h-full overflow-auto"
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualRows.map((virtualRow) => {
          const startIndex = virtualRow.index * COLUMNS;
          const rowPhotos = photos.slice(startIndex, startIndex + COLUMNS);

          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${ITEM_HEIGHT}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              className="grid grid-cols-4 gap-2 p-1"
            >
              {rowPhotos.map((photo, colIndex) => {
                const photoIndex = startIndex + colIndex;
                return (
                  <PhotoItem
                    key={photo.id}
                    photo={photo}
                    isSelected={selectedPhotos.has(photo.id)}
                    onSelect={() => onToggleSelection(photo.id)}
                    onView={() => onViewPhoto(photoIndex)}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      {isLoading && (
        <div className="flex justify-center py-8">
          <LoadingSpinner />
        </div>
      )}
    </div>
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
