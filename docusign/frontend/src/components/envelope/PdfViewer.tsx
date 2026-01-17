/**
 * PDF viewer component for displaying documents with field overlays.
 * Uses react-pdf to render PDF pages and overlays field markers.
 *
 * @param props - Component props
 * @returns The PDF viewer with field overlays
 */
import { Document, Page } from 'react-pdf';
import { DocumentField, Recipient } from '../../types';
import { LoadingSpinner } from '../common/LoadingSpinner';

interface PdfViewerProps {
  /** URL or path to the PDF document */
  documentUrl: string;
  /** Current page number to display */
  currentPage: number;
  /** Callback when PDF is loaded with page count */
  onLoadSuccess: (numPages: number) => void;
  /** Fields to overlay on the current page */
  currentPageFields: DocumentField[];
  /** Recipients for looking up field assignees */
  recipients: Recipient[];
  /** Whether the envelope is in draft status */
  isDraft: boolean;
  /** Selected recipient ID for field placement */
  selectedRecipient: string;
  /** Ref for the container element */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Handler for clicking on the document to add a field */
  onAddField?: (e: React.MouseEvent<HTMLDivElement>) => void;
}

export function PdfViewer({
  documentUrl,
  currentPage,
  onLoadSuccess,
  currentPageFields,
  recipients,
  isDraft,
  selectedRecipient,
  containerRef,
  onAddField,
}: PdfViewerProps) {
  const isClickable = isDraft && selectedRecipient;

  return (
    <div
      ref={containerRef}
      className="relative border rounded-lg overflow-hidden bg-gray-100"
      onClick={isClickable ? onAddField : undefined}
      style={{ cursor: isClickable ? 'crosshair' : 'default' }}
    >
      <Document
        file={documentUrl}
        onLoadSuccess={({ numPages }) => onLoadSuccess(numPages)}
        loading={<LoadingSpinner centered size="md" />}
      >
        <Page pageNumber={currentPage} width={700} />
      </Document>

      {currentPageFields.map((field) => {
        const recipient = recipients.find((r) => r.id === field.recipient_id);
        return (
          <FieldOverlay
            key={field.id}
            field={field}
            recipientName={recipient?.name}
          />
        );
      })}
    </div>
  );
}

/**
 * Individual field overlay marker on the PDF.
 */
interface FieldOverlayProps {
  field: DocumentField;
  recipientName?: string;
}

function FieldOverlay({ field, recipientName }: FieldOverlayProps) {
  return (
    <div
      className={`field-highlight ${field.type} ${field.completed ? 'completed' : ''}`}
      style={{
        left: field.x,
        top: field.y,
        width: field.width,
        height: field.height,
      }}
      title={`${field.type} - ${recipientName || 'Unknown'}`}
    >
      {field.completed && (
        <span className="absolute inset-0 flex items-center justify-center text-green-600 text-xs font-medium">
          Done
        </span>
      )}
    </div>
  );
}
