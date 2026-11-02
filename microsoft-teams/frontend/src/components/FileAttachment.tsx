import { fileApi } from '../services/api';

interface FileAttachmentProps {
  fileId: string;
  filename: string;
  contentType?: string;
  sizeBytes?: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Renders a file attachment card with icon, name, size, and download action. */
export function FileAttachment({ fileId, filename, contentType, sizeBytes }: FileAttachmentProps) {
  const handleDownload = async () => {
    try {
      const { url } = await fileApi.download(fileId);
      window.open(url, '_blank');
    } catch (err) {
      console.error('Failed to download file:', err);
    }
  };

  const isImage = contentType?.startsWith('image/');
  const icon = isImage ? '🖼️' : '📄';

  return (
    <div
      data-testid="file-attachment"
      onClick={handleDownload}
      className="inline-flex items-center gap-2 px-3 py-2 bg-teams-bg border border-teams-border rounded-lg cursor-pointer hover:bg-teams-border transition-colors max-w-xs"
    >
      <span className="text-xl">{icon}</span>
      <div className="min-w-0">
        <p className="text-sm text-teams-text truncate">{filename}</p>
        {/* `sizeBytes &&` rendered a literal "0" for an empty file. */}
        {sizeBytes != null ? (
          <p className="text-xs text-teams-secondary">{formatBytes(sizeBytes)}</p>
        ) : null}
      </div>
    </div>
  );
}
