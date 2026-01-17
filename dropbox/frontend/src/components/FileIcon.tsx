/**
 * File icon component that displays appropriate icon based on file type.
 * Uses Lucide React icons with color-coding by MIME type.
 * @module components/FileIcon
 */

import {
  Folder,
  File,
  Image,
  Video,
  Music,
  FileText,
  Archive,
  FileSpreadsheet,
  Presentation,
  FileType,
} from 'lucide-react';

/** Props for the FileIcon component */
interface FileIconProps {
  /** MIME type of the file (null for unknown) */
  mimeType: string | null;
  /** Whether this item is a folder */
  isFolder: boolean;
  /** Icon size in pixels (default 24) */
  size?: number;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Displays the appropriate icon for a file or folder.
 * Icons are color-coded by type (e.g., blue for folders, green for images).
 */
export function FileIcon({ mimeType, isFolder, size = 24, className = '' }: FileIconProps) {
  const iconProps = { size, className };

  if (isFolder) {
    return <Folder {...iconProps} className={`text-dropbox-blue ${className}`} />;
  }

  if (!mimeType) {
    return <File {...iconProps} className={`text-gray-400 ${className}`} />;
  }

  if (mimeType.startsWith('image/')) {
    return <Image {...iconProps} className={`text-green-500 ${className}`} />;
  }

  if (mimeType.startsWith('video/')) {
    return <Video {...iconProps} className={`text-purple-500 ${className}`} />;
  }

  if (mimeType.startsWith('audio/')) {
    return <Music {...iconProps} className={`text-pink-500 ${className}`} />;
  }

  if (mimeType === 'application/pdf') {
    return <FileText {...iconProps} className={`text-red-500 ${className}`} />;
  }

  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z')) {
    return <Archive {...iconProps} className={`text-yellow-600 ${className}`} />;
  }

  if (mimeType.startsWith('text/') || mimeType === 'application/json') {
    return <FileType {...iconProps} className={`text-blue-400 ${className}`} />;
  }

  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) {
    return <FileSpreadsheet {...iconProps} className={`text-green-600 ${className}`} />;
  }

  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) {
    return <Presentation {...iconProps} className={`text-orange-500 ${className}`} />;
  }

  if (mimeType.includes('word') || mimeType.includes('document')) {
    return <FileText {...iconProps} className={`text-blue-600 ${className}`} />;
  }

  return <File {...iconProps} className={`text-gray-400 ${className}`} />;
}
