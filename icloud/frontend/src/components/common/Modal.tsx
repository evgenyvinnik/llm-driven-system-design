import React from 'react';

/**
 * Props for the Modal component.
 */
export interface ModalProps {
  /** Whether the modal is visible */
  isOpen: boolean;
  /** Callback when modal should close (clicking overlay or pressing escape) */
  onClose: () => void;
  /** Modal title displayed at the top */
  title: string;
  /** Modal content */
  children: React.ReactNode;
}

/**
 * A reusable modal dialog component.
 *
 * Displays content in a centered overlay with a title.
 * Closes when clicking the overlay background or pressing escape.
 * Prevents event propagation to the overlay when clicking modal content.
 *
 * @example
 * ```tsx
 * <Modal
 *   isOpen={showModal}
 *   onClose={() => setShowModal(false)}
 *   title="Create New Item"
 * >
 *   <form>...</form>
 * </Modal>
 * ```
 *
 * @param props - Component props
 * @returns Modal overlay with centered content, or null if not open
 */
export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
}) => {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-4">{title}</h3>
        {children}
      </div>
    </div>
  );
};

/**
 * Props for the ModalActions component.
 */
export interface ModalActionsProps {
  /** Primary action button label */
  primaryLabel: string;
  /** Callback when primary button is clicked */
  onPrimaryClick: () => void;
  /** Cancel button label (defaults to 'Cancel') */
  cancelLabel?: string;
  /** Callback when cancel button is clicked */
  onCancel: () => void;
  /** Whether the primary button is disabled */
  primaryDisabled?: boolean;
}

/**
 * Standard action buttons for modals.
 *
 * Provides a consistent layout for modal footer with cancel and primary actions.
 *
 * @example
 * ```tsx
 * <ModalActions
 *   primaryLabel="Create"
 *   onPrimaryClick={handleCreate}
 *   onCancel={() => setShowModal(false)}
 * />
 * ```
 *
 * @param props - Component props
 * @returns Row of action buttons
 */
export const ModalActions: React.FC<ModalActionsProps> = ({
  primaryLabel,
  onPrimaryClick,
  cancelLabel = 'Cancel',
  onCancel,
  primaryDisabled = false,
}) => {
  return (
    <div className="flex justify-end gap-2 mt-4">
      <button
        className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded"
        onClick={onCancel}
      >
        {cancelLabel}
      </button>
      <button
        className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
        onClick={onPrimaryClick}
        disabled={primaryDisabled}
      >
        {primaryLabel}
      </button>
    </div>
  );
};
