/**
 * File browser components for the iCloud application.
 *
 * These components provide file browsing and management functionality:
 * - File/folder list with icons and metadata
 * - Toolbar with breadcrumb navigation and actions
 * - Status banners for errors, conflicts, and uploads
 * - Modals for creating folders
 * - Selection and drag-and-drop support
 *
 * @module components/files
 */

export { FileItemComponent } from './FileItemComponent';
export type { FileItemComponentProps } from './FileItemComponent';

export { FileToolbar } from './FileToolbar';
export type { FileToolbarProps } from './FileToolbar';

export { FileList } from './FileList';
export type { FileListProps } from './FileList';

export { FileStatusBanners } from './FileStatusBanners';
export type { FileStatusBannersProps } from './FileStatusBanners';

export { NewFolderModal } from './NewFolderModal';
export type { NewFolderModalProps } from './NewFolderModal';

export { SelectionBar } from './SelectionBar';
export type { SelectionBarProps } from './SelectionBar';

export { DragOverlay } from './DragOverlay';
export type { DragOverlayProps } from './DragOverlay';
