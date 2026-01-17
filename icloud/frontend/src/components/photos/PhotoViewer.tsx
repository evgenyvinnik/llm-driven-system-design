import React, { useEffect } from 'react';
import type { Photo } from '../../types';
import { usePhotoStore } from '../../stores/photoStore';
import { formatDate } from '../../utils/helpers';

/**
 * Props for the PhotoViewer component.
 */
export interface PhotoViewerProps {
  /** Photo currently being viewed */
  photo: Photo;
  /** Callback to close the viewer */
  onClose: () => void;
  /** Callback to view previous photo */
  onPrev: () => void;
  /** Callback to view next photo */
  onNext: () => void;
  /** Whether there is a previous photo */
  hasPrev: boolean;
  /** Whether there is a next photo */
  hasNext: boolean;
}

/**
 * Full-screen photo viewer (lightbox) component.
 *
 * Displays a photo in full-screen mode with:
 * - Close button (X) in the header
 * - Favorite toggle button (heart icon)
 * - Delete button
 * - Previous/Next navigation arrows
 * - Photo metadata (date taken, dimensions) in the footer
 *
 * Supports keyboard navigation:
 * - Arrow Left: Previous photo
 * - Arrow Right: Next photo
 * - Escape: Close viewer
 *
 * @example
 * ```tsx
 * {viewingPhoto && (
 *   <PhotoViewer
 *     photo={viewingPhoto}
 *     onClose={() => setViewingPhotoIndex(null)}
 *     onPrev={() => setViewingPhotoIndex(i => i - 1)}
 *     onNext={() => setViewingPhotoIndex(i => i + 1)}
 *     hasPrev={viewingPhotoIndex > 0}
 *     hasNext={viewingPhotoIndex < photos.length - 1}
 *   />
 * )}
 * ```
 *
 * @param props - Component props
 * @returns Full-screen photo viewer modal
 */
export const PhotoViewer: React.FC<PhotoViewerProps> = ({
  photo,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}) => {
  const { toggleFavorite, deletePhoto } = usePhotoStore();

  /**
   * Sets up keyboard event listeners for navigation.
   */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && hasPrev) onPrev();
      if (e.key === 'ArrowRight' && hasNext) onNext();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onPrev, onNext, hasPrev, hasNext]);

  /**
   * Handles photo deletion with confirmation.
   */
  const handleDelete = async () => {
    if (confirm('Delete this photo?')) {
      await deletePhoto(photo.id);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col">
      <ViewerHeader
        photo={photo}
        onClose={onClose}
        onToggleFavorite={() => toggleFavorite(photo.id)}
        onDelete={handleDelete}
      />
      <ViewerContent
        photo={photo}
        onPrev={onPrev}
        onNext={onNext}
        hasPrev={hasPrev}
        hasNext={hasNext}
      />
      <ViewerFooter photo={photo} />
    </div>
  );
};

/**
 * Props for the ViewerHeader component.
 */
interface ViewerHeaderProps {
  photo: Photo;
  onClose: () => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
}

/**
 * Header section of the photo viewer.
 *
 * Contains close, favorite, and delete buttons.
 *
 * @param props - Component props
 * @returns Header with action buttons
 */
const ViewerHeader: React.FC<ViewerHeaderProps> = ({
  photo,
  onClose,
  onToggleFavorite,
  onDelete,
}) => (
  <div className="flex items-center justify-between p-4 text-white">
    <button onClick={onClose} className="p-2 hover:bg-white/10 rounded">
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>

    <div className="flex items-center gap-4">
      <button
        onClick={onToggleFavorite}
        className="p-2 hover:bg-white/10 rounded"
        aria-label={photo.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
      >
        <svg
          className={`w-6 h-6 ${photo.isFavorite ? 'text-red-500 fill-current' : ''}`}
          fill={photo.isFavorite ? 'currentColor' : 'none'}
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
          />
        </svg>
      </button>

      <button
        onClick={onDelete}
        className="p-2 hover:bg-white/10 rounded text-red-400"
        aria-label="Delete photo"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
          />
        </svg>
      </button>
    </div>
  </div>
);

/**
 * Props for the ViewerContent component.
 */
interface ViewerContentProps {
  photo: Photo;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
}

/**
 * Main content area of the photo viewer.
 *
 * Displays the photo with optional navigation arrows.
 *
 * @param props - Component props
 * @returns Photo display with navigation controls
 */
const ViewerContent: React.FC<ViewerContentProps> = ({
  photo,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}) => (
  <div className="flex-1 flex items-center justify-center relative">
    {hasPrev && (
      <button
        onClick={onPrev}
        className="absolute left-4 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white"
        aria-label="Previous photo"
      >
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>
    )}

    <img
      src={photo.previewUrl}
      alt=""
      className="max-h-full max-w-full object-contain"
    />

    {hasNext && (
      <button
        onClick={onNext}
        className="absolute right-4 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white"
        aria-label="Next photo"
      >
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
    )}
  </div>
);

/**
 * Props for the ViewerFooter component.
 */
interface ViewerFooterProps {
  photo: Photo;
}

/**
 * Footer section of the photo viewer.
 *
 * Displays photo metadata: date taken and dimensions.
 *
 * @param props - Component props
 * @returns Footer with photo metadata
 */
const ViewerFooter: React.FC<ViewerFooterProps> = ({ photo }) => (
  <div className="p-4 text-white text-center">
    {photo.takenAt && <p>{formatDate(photo.takenAt)}</p>}
    <p className="text-sm text-gray-400">
      {photo.width} x {photo.height}
    </p>
  </div>
);
