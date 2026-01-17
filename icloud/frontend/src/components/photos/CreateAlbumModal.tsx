import React from 'react';
import { Modal, ModalActions } from '../common';

/**
 * Props for the CreateAlbumModal component.
 */
export interface CreateAlbumModalProps {
  /** Whether the modal is visible */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Current album name input value */
  albumName: string;
  /** Callback when album name changes */
  onAlbumNameChange: (name: string) => void;
  /** Callback when album should be created */
  onCreateAlbum: () => void;
  /** Number of photos that will be added to the album */
  selectedPhotoCount: number;
}

/**
 * Modal dialog for creating a new photo album.
 *
 * Allows the user to enter an album name and shows how many
 * currently selected photos will be added to the album.
 *
 * Supports keyboard interaction:
 * - Enter: Create album
 * - Escape: Close modal (handled by Modal component)
 *
 * @example
 * ```tsx
 * <CreateAlbumModal
 *   isOpen={showCreateAlbum}
 *   onClose={() => setShowCreateAlbum(false)}
 *   albumName={albumName}
 *   onAlbumNameChange={setAlbumName}
 *   onCreateAlbum={handleCreateAlbum}
 *   selectedPhotoCount={selectedPhotos.size}
 * />
 * ```
 *
 * @param props - Component props
 * @returns Album creation modal or null if not open
 */
export const CreateAlbumModal: React.FC<CreateAlbumModalProps> = ({
  isOpen,
  onClose,
  albumName,
  onAlbumNameChange,
  onCreateAlbum,
  selectedPhotoCount,
}) => {
  /**
   * Handles key down events for the input.
   * Creates album on Enter key press.
   */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onCreateAlbum();
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create Album">
      <input
        type="text"
        placeholder="Album name"
        value={albumName}
        onChange={(e) => onAlbumNameChange(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        autoFocus
      />
      <p className="text-sm text-gray-500 mt-2">
        {selectedPhotoCount} photo(s) will be added to this album
      </p>
      <ModalActions
        primaryLabel="Create"
        onPrimaryClick={onCreateAlbum}
        onCancel={onClose}
        primaryDisabled={!albumName.trim()}
      />
    </Modal>
  );
};
