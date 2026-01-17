import React from 'react';
import { Modal, ModalActions } from '../common';

/**
 * Props for the NewFolderModal component.
 */
export interface NewFolderModalProps {
  /** Whether the modal is visible */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Current folder name input value */
  folderName: string;
  /** Callback when folder name changes */
  onFolderNameChange: (name: string) => void;
  /** Callback when folder should be created */
  onCreateFolder: () => void;
}

/**
 * Modal dialog for creating a new folder.
 *
 * Allows the user to enter a folder name.
 *
 * Supports keyboard interaction:
 * - Enter: Create folder
 * - Escape: Close modal (handled by Modal component)
 *
 * @example
 * ```tsx
 * <NewFolderModal
 *   isOpen={showNewFolderModal}
 *   onClose={() => setShowNewFolderModal(false)}
 *   folderName={newFolderName}
 *   onFolderNameChange={setNewFolderName}
 *   onCreateFolder={handleCreateFolder}
 * />
 * ```
 *
 * @param props - Component props
 * @returns New folder modal or null if not open
 */
export const NewFolderModal: React.FC<NewFolderModalProps> = ({
  isOpen,
  onClose,
  folderName,
  onFolderNameChange,
  onCreateFolder,
}) => {
  /**
   * Handles key down events for the input.
   * Creates folder on Enter key press.
   */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onCreateFolder();
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New Folder">
      <input
        type="text"
        placeholder="Folder name"
        value={folderName}
        onChange={(e) => onFolderNameChange(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        autoFocus
      />
      <ModalActions
        primaryLabel="Create"
        onPrimaryClick={onCreateFolder}
        onCancel={onClose}
        primaryDisabled={!folderName.trim()}
      />
    </Modal>
  );
};
