/**
 * Common UI components shared across the iCloud application.
 *
 * These components provide consistent styling and behavior for
 * common UI patterns like cards, modals, and loading states.
 *
 * @module components/common
 */

export { StatCard } from './StatCard';
export type { StatCardProps, StatCardColor } from './StatCard';

export { LoadingSpinner, CenteredSpinner } from './LoadingSpinner';
export type { LoadingSpinnerProps, CenteredSpinnerProps } from './LoadingSpinner';

export { Modal, ModalActions } from './Modal';
export type { ModalProps, ModalActionsProps } from './Modal';
