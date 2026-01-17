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

interface FileIconProps {
  mimeType: string | null;
  isFolder: boolean;
  size?: number;
  className?: string;
}

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
