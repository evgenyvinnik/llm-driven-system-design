/**
 * Fields tab component for managing document fields.
 * Provides interface for placing signature, initial, date, text, and checkbox fields.
 *
 * @param props - Component props
 * @returns The fields management tab content
 */
import { DocumentField, Recipient } from '../../types';
import { PdfViewer } from './PdfViewer';
import { FieldsSidebar } from './FieldsSidebar';

interface DocumentItem {
  id: string;
  name: string;
}

interface FieldsTabProps {
  /** Available documents */
  documents: DocumentItem[];
  /** All recipients */
  recipients: Recipient[];
  /** All fields in the envelope */
  fields: DocumentField[];
  /** Fields on the current page of the current document */
  currentPageFields: DocumentField[];
  /** Whether the envelope is editable */
  isDraft: boolean;
  /** Currently selected document index */
  selectedDocIndex: number;
  /** Total number of pages in current document */
  numPages: number;
  /** Current page number */
  currentPage: number;
  /** Selected recipient for field placement */
  selectedRecipient: string;
  /** Selected field type for placement */
  selectedFieldType: string;
  /** Ref for the PDF container element */
  pdfContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Handler for document selection */
  onDocSelect: (index: number) => void;
  /** Handler for PDF load completion */
  onPageLoad: (numPages: number) => void;
  /** Handler for page changes */
  onPageChange: (page: number) => void;
  /** Handler for recipient selection */
  onRecipientSelect: (id: string) => void;
  /** Handler for field type selection */
  onFieldTypeSelect: (type: string) => void;
  /** Handler for adding a field */
  onAddField: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** Handler for field deletion */
  onDeleteField: (id: string) => void;
}

export function FieldsTab({
  documents,
  recipients,
  fields,
  currentPageFields,
  isDraft,
  selectedDocIndex,
  numPages,
  currentPage,
  selectedRecipient,
  selectedFieldType,
  pdfContainerRef,
  onDocSelect,
  onPageLoad,
  onPageChange,
  onRecipientSelect,
  onFieldTypeSelect,
  onAddField,
  onDeleteField,
}: FieldsTabProps) {
  // Guard: No documents uploaded yet
  if (documents.length === 0) {
    return (
      <EmptyState message="Please upload a document first." />
    );
  }

  // Guard: No recipients added yet
  if (recipients.length === 0) {
    return (
      <EmptyState message="Please add at least one recipient first." />
    );
  }

  const currentDoc = documents[selectedDocIndex];

  return (
    <div className="grid grid-cols-4 gap-6">
      <FieldsSidebar
        documents={documents}
        recipients={recipients}
        fields={fields}
        isDraft={isDraft}
        selectedDocIndex={selectedDocIndex}
        numPages={numPages}
        currentPage={currentPage}
        selectedRecipient={selectedRecipient}
        selectedFieldType={selectedFieldType}
        onDocSelect={onDocSelect}
        onPageChange={onPageChange}
        onRecipientSelect={onRecipientSelect}
        onFieldTypeSelect={onFieldTypeSelect}
        onDeleteField={onDeleteField}
      />

      <div className="col-span-3 bg-white rounded-lg shadow p-4">
        <PdfViewer
          documentUrl={`/api/v1/documents/${currentDoc.id}/view`}
          currentPage={currentPage}
          onLoadSuccess={onPageLoad}
          currentPageFields={currentPageFields}
          recipients={recipients}
          isDraft={isDraft}
          selectedRecipient={selectedRecipient}
          containerRef={pdfContainerRef}
          onAddField={onAddField}
        />
      </div>
    </div>
  );
}

/**
 * Empty state component for missing prerequisites.
 */
interface EmptyStateProps {
  message: string;
}

function EmptyState({ message }: EmptyStateProps) {
  return (
    <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
      {message}
    </div>
  );
}
