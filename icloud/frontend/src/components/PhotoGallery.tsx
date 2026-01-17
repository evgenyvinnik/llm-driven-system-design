import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePhotoStore } from '../stores/photoStore';
import { PhotoToolbar, PhotoGrid, PhotoViewer, CreateAlbumModal } from './photos';

/**
 * Main photo gallery component for iCloud Photos.
 *
 * Provides a complete photo browsing experience including:
 * - Responsive thumbnail grid with lazy loading
 * - Infinite scroll pagination
 * - Filter toggle between all photos and favorites
 * - Multi-select for batch operations
 * - Photo upload with automatic thumbnail generation
 * - Album creation with selected photos
 * - Full-screen photo viewer with navigation
 *
 * The component uses the photo store for state management and
 * subscribes to WebSocket events for real-time sync updates.
 *
 * @example
 * ```tsx
 * <PhotoGallery />
 * ```
 *
 * @returns Complete photo gallery UI
 */
export const PhotoGallery: React.FC = () => {
  const {
    photos,
    selectedPhotos,
    isLoading,
    hasMore,
    error,
    filter,
    loadPhotos,
    loadMore,
    uploadPhotos,
    toggleSelection,
    clearSelection,
    setFilter,
    loadAlbums,
    createAlbum,
    clearError,
  } = usePhotoStore();

  const [viewingPhotoIndex, setViewingPhotoIndex] = useState<number | null>(null);
  const [showCreateAlbum, setShowCreateAlbum] = useState(false);
  const [albumName, setAlbumName] = useState('');
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  /**
   * Load photos and albums on component mount.
   */
  useEffect(() => {
    loadPhotos();
    loadAlbums();
  }, [loadPhotos, loadAlbums]);

  /**
   * Set up infinite scroll handler.
   * Loads more photos when user scrolls near the bottom.
   */
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const nearBottom =
        container.scrollHeight - container.scrollTop <= container.clientHeight + 200;
      if (nearBottom && hasMore && !isLoading) {
        loadMore();
      }
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [hasMore, isLoading, loadMore]);

  /**
   * Handles file upload from the toolbar.
   */
  const handleUpload = useCallback(
    (files: File[]) => {
      uploadPhotos(files);
    },
    [uploadPhotos]
  );

  /**
   * Handles album creation.
   * Creates the album if name is not empty, then resets state.
   */
  const handleCreateAlbum = async () => {
    if (albumName.trim()) {
      await createAlbum(albumName.trim());
      setAlbumName('');
      setShowCreateAlbum(false);
    }
  };

  /**
   * Gets the currently viewing photo, if any.
   */
  const viewingPhoto = viewingPhotoIndex !== null ? photos[viewingPhotoIndex] : null;

  return (
    <div className="flex flex-col h-full">
      <PhotoToolbar
        filter={filter}
        onFilterChange={setFilter}
        selectedCount={selectedPhotos.size}
        onCreateAlbum={() => setShowCreateAlbum(true)}
        onClearSelection={clearSelection}
        onUpload={handleUpload}
      />

      <ErrorMessage error={error} onDismiss={clearError} />

      <div ref={scrollContainerRef} className="flex-1 overflow-auto p-4">
        <PhotoGrid
          photos={photos}
          selectedPhotos={selectedPhotos}
          isLoading={isLoading}
          onToggleSelection={toggleSelection}
          onViewPhoto={setViewingPhotoIndex}
        />
      </div>

      {viewingPhoto && (
        <PhotoViewer
          photo={viewingPhoto}
          onClose={() => setViewingPhotoIndex(null)}
          onPrev={() => setViewingPhotoIndex((i) => Math.max(0, (i || 0) - 1))}
          onNext={() =>
            setViewingPhotoIndex((i) => Math.min(photos.length - 1, (i || 0) + 1))
          }
          hasPrev={viewingPhotoIndex > 0}
          hasNext={viewingPhotoIndex < photos.length - 1}
        />
      )}

      <CreateAlbumModal
        isOpen={showCreateAlbum}
        onClose={() => setShowCreateAlbum(false)}
        albumName={albumName}
        onAlbumNameChange={setAlbumName}
        onCreateAlbum={handleCreateAlbum}
        selectedPhotoCount={selectedPhotos.size}
      />
    </div>
  );
};

/**
 * Props for the ErrorMessage component.
 */
interface ErrorMessageProps {
  /** Error message to display, or null */
  error: string | null;
  /** Callback when dismiss button is clicked */
  onDismiss: () => void;
}

/**
 * Error message banner component.
 *
 * Displays an error message with a dismiss button.
 * Returns null if there is no error.
 *
 * @param props - Component props
 * @returns Error banner or null
 */
const ErrorMessage: React.FC<ErrorMessageProps> = ({ error, onDismiss }) => {
  if (!error) return null;

  return (
    <div className="mx-4 mt-4 p-3 bg-red-100 text-red-700 rounded flex justify-between">
      <span>{error}</span>
      <button onClick={onDismiss}>Dismiss</button>
    </div>
  );
};
