import React from 'react';
import type { Conflict } from '../../types';

/**
 * Props for the FileStatusBanners component.
 */
export interface FileStatusBannersProps {
  /** Error message to display, or null */
  error: string | null;
  /** Callback when error dismiss button is clicked */
  onClearError: () => void;
  /** List of file conflicts */
  conflicts: Conflict[];
  /** Map of file names to upload progress (0-100) */
  uploadProgress: Map<string, number>;
}

/**
 * Status banners for the file browser.
 *
 * Displays contextual banners for:
 * - Error messages (red, dismissible)
 * - Conflict warnings (yellow)
 * - Upload progress indicators
 *
 * @example
 * ```tsx
 * <FileStatusBanners
 *   error={error}
 *   onClearError={clearError}
 *   conflicts={conflicts}
 *   uploadProgress={uploadProgress}
 * />
 * ```
 *
 * @param props - Component props
 * @returns Status banners or null if none to show
 */
export const FileStatusBanners: React.FC<FileStatusBannersProps> = ({
  error,
  onClearError,
  conflicts,
  uploadProgress,
}) => {
  return (
    <>
      {error && <ErrorBanner error={error} onDismiss={onClearError} />}
      {conflicts.length > 0 && <ConflictWarning conflictCount={conflicts.length} />}
      {uploadProgress.size > 0 && <UploadProgress uploadProgress={uploadProgress} />}
    </>
  );
};

/**
 * Props for the ErrorBanner component.
 */
interface ErrorBannerProps {
  error: string;
  onDismiss: () => void;
}

/**
 * Error banner with dismiss button.
 *
 * @param props - Component props
 * @returns Error banner
 */
const ErrorBanner: React.FC<ErrorBannerProps> = ({ error, onDismiss }) => (
  <div className="mx-4 mt-4 p-3 bg-red-100 text-red-700 rounded flex justify-between items-center">
    <span>{error}</span>
    <button onClick={onDismiss} className="text-red-500 hover:text-red-700">
      Dismiss
    </button>
  </div>
);

/**
 * Props for the ConflictWarning component.
 */
interface ConflictWarningProps {
  conflictCount: number;
}

/**
 * Warning banner for unresolved conflicts.
 *
 * @param props - Component props
 * @returns Conflict warning banner
 */
const ConflictWarning: React.FC<ConflictWarningProps> = ({ conflictCount }) => (
  <div className="mx-4 mt-4 p-3 bg-yellow-100 text-yellow-800 rounded">
    You have {conflictCount} file conflict(s) that need resolution.
  </div>
);

/**
 * Props for the UploadProgress component.
 */
interface UploadProgressProps {
  uploadProgress: Map<string, number>;
}

/**
 * Upload progress indicators for active uploads.
 *
 * @param props - Component props
 * @returns Upload progress bars
 */
const UploadProgress: React.FC<UploadProgressProps> = ({ uploadProgress }) => (
  <div className="mx-4 mt-4 space-y-2">
    {Array.from(uploadProgress.entries()).map(([name, progress]) => (
      <div key={name} className="flex items-center gap-2">
        <span className="text-sm truncate flex-1">{name}</span>
        <div className="w-24 progress-bar">
          <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
        </div>
      </div>
    ))}
  </div>
);
