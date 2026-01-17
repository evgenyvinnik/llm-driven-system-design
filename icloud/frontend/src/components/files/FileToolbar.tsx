import React from 'react';

/**
 * Props for the FileToolbar component.
 */
export interface FileToolbarProps {
  /** Current path as array of breadcrumb items */
  breadcrumbs: Array<{ name: string; path: string }>;
  /** Callback when navigating to a path */
  onNavigate: (path: string) => void;
  /** Callback when "New Folder" is clicked */
  onNewFolder: () => void;
  /** Callback when files are selected for upload */
  onUpload: (files: File[]) => void;
}

/**
 * Toolbar for the file browser.
 *
 * Provides:
 * - Breadcrumb navigation showing current path
 * - "New Folder" button
 * - "Upload" button with file input
 *
 * @example
 * ```tsx
 * <FileToolbar
 *   breadcrumbs={[
 *     { name: 'iCloud Drive', path: '/' },
 *     { name: 'Documents', path: '/Documents' },
 *   ]}
 *   onNavigate={navigateToPath}
 *   onNewFolder={() => setShowNewFolderModal(true)}
 *   onUpload={uploadFiles}
 * />
 * ```
 *
 * @param props - Component props
 * @returns Toolbar with breadcrumb and action buttons
 */
export const FileToolbar: React.FC<FileToolbarProps> = ({
  breadcrumbs,
  onNavigate,
  onNewFolder,
  onUpload,
}) => {
  /**
   * Handles file input change event.
   */
  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []);
    if (selectedFiles.length > 0) {
      onUpload(selectedFiles);
    }
    // Reset input so same file can be selected again
    e.target.value = '';
  };

  return (
    <div className="flex items-center justify-between p-4 border-b">
      <Breadcrumb breadcrumbs={breadcrumbs} onNavigate={onNavigate} />
      <div className="flex items-center gap-2">
        <button
          className="px-3 py-1.5 text-sm bg-gray-100 rounded hover:bg-gray-200"
          onClick={onNewFolder}
        >
          New Folder
        </button>
        <label className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 cursor-pointer">
          Upload
          <input
            type="file"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
          />
        </label>
      </div>
    </div>
  );
};

/**
 * Props for the Breadcrumb component.
 */
interface BreadcrumbProps {
  breadcrumbs: Array<{ name: string; path: string }>;
  onNavigate: (path: string) => void;
}

/**
 * Breadcrumb navigation component.
 *
 * Shows the current path as clickable links separated by "/".
 *
 * @param props - Component props
 * @returns Breadcrumb navigation
 */
const Breadcrumb: React.FC<BreadcrumbProps> = ({ breadcrumbs, onNavigate }) => (
  <nav className="breadcrumb">
    {breadcrumbs.map((crumb, index) => (
      <React.Fragment key={crumb.path}>
        {index > 0 && <span className="breadcrumb-separator">/</span>}
        <button
          className="breadcrumb-item hover:underline"
          onClick={() => onNavigate(crumb.path)}
        >
          {crumb.name}
        </button>
      </React.Fragment>
    ))}
  </nav>
);
