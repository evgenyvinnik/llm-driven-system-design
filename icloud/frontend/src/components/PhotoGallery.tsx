import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Photo } from '../types';
import { usePhotoStore } from '../stores/photoStore';
import { formatDate } from '../utils/helpers';

/**
 * Props for the PhotoItem component.
 */
interface PhotoItemProps {
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
 * Displays the photo thumbnail with a favorite indicator and selection state.
 * Supports lazy loading for performance with large galleries.
 *
 * @param props - Component props
 * @returns Photo thumbnail element
 */
const PhotoItem: React.FC<PhotoItemProps> = ({ photo, isSelected, onSelect, onView }) => {
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

/**
 * Props for the PhotoViewer component.
 */
interface PhotoViewerProps {
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
 * Displays a photo in full-screen mode with navigation controls,
 * favorite toggle, and delete button. Supports keyboard navigation
 * (arrow keys for prev/next, Escape to close).
 *
 * @param props - Component props
 * @returns Full-screen photo viewer modal
 */
const PhotoViewer: React.FC<PhotoViewerProps> = ({
  photo,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}) => {
  const { toggleFavorite, deletePhoto } = usePhotoStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && hasPrev) onPrev();
      if (e.key === 'ArrowRight' && hasNext) onNext();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onPrev, onNext, hasPrev, hasNext]);

  const handleDelete = async () => {
    if (confirm('Delete this photo?')) {
      await deletePhoto(photo.id);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 text-white">
        <button onClick={onClose} className="p-2 hover:bg-white/10 rounded">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="flex items-center gap-4">
          <button
            onClick={() => toggleFavorite(photo.id)}
            className="p-2 hover:bg-white/10 rounded"
          >
            <svg
              className={`w-6 h-6 ${photo.isFavorite ? 'text-red-500 fill-current' : ''}`}
              fill={photo.isFavorite ? 'currentColor' : 'none'}
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
          </button>

          <button onClick={handleDelete} className="p-2 hover:bg-white/10 rounded text-red-400">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>

      {/* Image */}
      <div className="flex-1 flex items-center justify-center relative">
        {hasPrev && (
          <button
            onClick={onPrev}
            className="absolute left-4 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white"
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
          >
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}
      </div>

      {/* Footer */}
      <div className="p-4 text-white text-center">
        {photo.takenAt && <p>{formatDate(photo.takenAt)}</p>}
        <p className="text-sm text-gray-400">
          {photo.width} x {photo.height}
        </p>
      </div>
    </div>
  );
};

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
 * @returns Complete photo gallery UI
 */
export const PhotoGallery: React.FC = () => {
  const {
    photos,
    albums,
    selectedPhotos,
    isLoading,
    hasMore,
    error,
    viewMode,
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

  useEffect(() => {
    loadPhotos();
    loadAlbums();
  }, [loadPhotos, loadAlbums]);

  // Infinite scroll
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      if (
        container.scrollHeight - container.scrollTop <= container.clientHeight + 200 &&
        hasMore &&
        !isLoading
      ) {
        loadMore();
      }
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [hasMore, isLoading, loadMore]);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []).filter((f) =>
        f.type.startsWith('image/')
      );
      if (files.length > 0) {
        uploadPhotos(files);
      }
    },
    [uploadPhotos]
  );

  const handleCreateAlbum = async () => {
    if (albumName.trim()) {
      await createAlbum(albumName.trim());
      setAlbumName('');
      setShowCreateAlbum(false);
    }
  };

  const viewingPhoto = viewingPhotoIndex !== null ? photos[viewingPhotoIndex] : null;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center gap-4">
          <h2 className="text-xl font-semibold">Photos</h2>

          <div className="flex bg-gray-100 rounded-lg p-1">
            <button
              className={`px-3 py-1 text-sm rounded ${filter === 'all' ? 'bg-white shadow' : ''}`}
              onClick={() => setFilter('all')}
            >
              All
            </button>
            <button
              className={`px-3 py-1 text-sm rounded ${filter === 'favorites' ? 'bg-white shadow' : ''}`}
              onClick={() => setFilter('favorites')}
            >
              Favorites
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {selectedPhotos.size > 0 && (
            <>
              <span className="text-sm text-gray-500">
                {selectedPhotos.size} selected
              </span>
              <button
                className="px-3 py-1.5 text-sm bg-gray-100 rounded hover:bg-gray-200"
                onClick={() => setShowCreateAlbum(true)}
              >
                Create Album
              </button>
              <button
                className="text-sm text-gray-500 hover:text-gray-700"
                onClick={clearSelection}
              >
                Clear
              </button>
            </>
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

      {/* Error */}
      {error && (
        <div className="mx-4 mt-4 p-3 bg-red-100 text-red-700 rounded flex justify-between">
          <span>{error}</span>
          <button onClick={clearError}>Dismiss</button>
        </div>
      )}

      {/* Photo grid */}
      <div ref={scrollContainerRef} className="flex-1 overflow-auto p-4">
        {photos.length === 0 && !isLoading ? (
          <div className="flex flex-col items-center justify-center h-64 text-gray-500">
            <svg className="w-16 h-16 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <p>No photos yet</p>
            <p className="text-sm">Upload some photos to get started</p>
          </div>
        ) : (
          <div className="photo-grid">
            {photos.map((photo, index) => (
              <PhotoItem
                key={photo.id}
                photo={photo}
                isSelected={selectedPhotos.has(photo.id)}
                onSelect={() => toggleSelection(photo.id)}
                onView={() => setViewingPhotoIndex(index)}
              />
            ))}
          </div>
        )}

        {isLoading && (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
          </div>
        )}
      </div>

      {/* Photo viewer */}
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

      {/* Create album modal */}
      {showCreateAlbum && (
        <div className="modal-overlay" onClick={() => setShowCreateAlbum(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-4">Create Album</h3>
            <input
              type="text"
              placeholder="Album name"
              value={albumName}
              onChange={(e) => setAlbumName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateAlbum()}
              className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
            <p className="text-sm text-gray-500 mt-2">
              {selectedPhotos.size} photo(s) will be added to this album
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded"
                onClick={() => setShowCreateAlbum(false)}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                onClick={handleCreateAlbum}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
