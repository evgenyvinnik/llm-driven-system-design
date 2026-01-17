/**
 * PDF viewer component for the signing page.
 * Displays the document with interactive field overlays.
 *
 * @param props - Component props
 * @returns The signing PDF viewer
 */
import { Document, Page } from 'react-pdf';
import { DocumentField } from '../../types';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { CheckIcon } from '../icons/CheckIcon';

interface SigningPdfViewerProps {
  /** URL to fetch the document */
  documentUrl: string;
  /** Current page number */
  currentPage: number;
  /** Callback when PDF loads */
  onLoadSuccess: (numPages: number) => void;
  /** Fields on the current page */
  currentPageFields: DocumentField[];
  /** Set of completed field IDs */
  completedFields: Set<string>;
  /** Handler for field click */
  onFieldClick: (field: DocumentField) => void;
}

export function SigningPdfViewer({
  documentUrl,
  currentPage,
  onLoadSuccess,
  currentPageFields,
  completedFields,
  onFieldClick,
}: SigningPdfViewerProps) {
  return (
    <div className="col-span-3 bg-white rounded-lg shadow p-4">
      <div className="relative border rounded-lg overflow-hidden bg-gray-100">
        <Document
          file={documentUrl}
          onLoadSuccess={({ numPages }) => onLoadSuccess(numPages)}
          loading={<LoadingSpinner centered size="md" />}
        >
          <Page pageNumber={currentPage} width={700} />
        </Document>

        {currentPageFields.map((field) => (
          <SigningFieldOverlay
            key={field.id}
            field={field}
            isCompleted={completedFields.has(field.id)}
            onClick={() => onFieldClick(field)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Interactive field overlay for signing.
 */
interface SigningFieldOverlayProps {
  field: DocumentField;
  isCompleted: boolean;
  onClick: () => void;
}

function SigningFieldOverlay({ field, isCompleted, onClick }: SigningFieldOverlayProps) {
  /**
   * Handles field click, preventing action if already completed.
   */
  const handleClick = () => {
    if (!isCompleted) {
      onClick();
    }
  };

  /**
   * Gets the label for the field type.
   */
  const getFieldLabel = (type: string): string => {
    switch (type) {
      case 'signature':
        return 'Sign here';
      case 'initial':
        return 'Initial';
      default:
        return type;
    }
  };

  return (
    <div
      className={`field-highlight ${field.type} ${isCompleted ? 'completed' : ''}`}
      style={{
        left: field.x,
        top: field.y,
        width: field.width,
        height: field.height,
      }}
      onClick={handleClick}
    >
      {isCompleted ? (
        <span className="absolute inset-0 flex items-center justify-center text-green-600">
          <CheckIcon className="w-6 h-6" />
        </span>
      ) : (
        <span className="absolute inset-0 flex items-center justify-center text-xs font-medium opacity-70">
          {getFieldLabel(field.type)}
        </span>
      )}
    </div>
  );
}
