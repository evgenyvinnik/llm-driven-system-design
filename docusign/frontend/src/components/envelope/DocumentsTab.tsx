/**
 * Documents tab component for displaying and managing envelope documents.
 * Allows uploading PDF documents and viewing/deleting existing ones.
 *
 * @param props - Component props
 * @param props.documents - Array of documents in the envelope
 * @param props.isDraft - Whether the envelope is in draft status (allows editing)
 * @param props.onUpload - Handler for file upload
 * @param props.onDelete - Handler for document deletion
 * @returns The documents management tab content
 */
import { PdfIcon } from '../icons/PdfIcon';

interface DocumentItem {
  /** Document unique identifier */
  id: string;
  /** Document filename */
  name: string;
  /** Number of pages in the document */
  page_count: number;
  /** File size in bytes */
  file_size: number;
}

interface DocumentsTabProps {
  /** Array of documents to display */
  documents: DocumentItem[];
  /** Whether the envelope is editable */
  isDraft: boolean;
  /** Handler for file upload events */
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Handler for document deletion */
  onDelete: (id: string) => void;
}

/**
 * Formats file size from bytes to human-readable format.
 *
 * @param bytes - File size in bytes
 * @returns Formatted size string (e.g., "245 KB")
 */
function formatFileSize(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

export function DocumentsTab({
  documents,
  isDraft,
  onUpload,
  onDelete,
}: DocumentsTabProps) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">Documents</h2>
        {isDraft && (
          <label className="bg-docusign-blue text-white px-4 py-2 rounded-lg font-medium hover:bg-docusign-dark cursor-pointer">
            Upload PDF
            <input
              type="file"
              accept=".pdf"
              onChange={onUpload}
              className="hidden"
            />
          </label>
        )}
      </div>

      {documents.length === 0 ? (
        <p className="text-gray-500 text-center py-8">
          No documents uploaded yet.
        </p>
      ) : (
        <div className="space-y-3">
          {documents.map((doc) => (
            <DocumentRow
              key={doc.id}
              document={doc}
              isDraft={isDraft}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Individual document row component.
 */
interface DocumentRowProps {
  document: DocumentItem;
  isDraft: boolean;
  onDelete: (id: string) => void;
}

function DocumentRow({ document, isDraft, onDelete }: DocumentRowProps) {
  return (
    <div className="flex items-center justify-between p-4 border rounded-lg">
      <div className="flex items-center space-x-4">
        <PdfIcon />
        <div>
          <div className="font-medium">{document.name}</div>
          <div className="text-sm text-gray-500">
            {document.page_count} pages | {formatFileSize(document.file_size)}
          </div>
        </div>
      </div>
      {isDraft && (
        <button
          onClick={() => onDelete(document.id)}
          className="text-red-600 hover:text-red-900 text-sm"
        >
          Delete
        </button>
      )}
    </div>
  );
}
