/**
 * Signing page sidebar component.
 * Contains document selector, page navigation, and fields checklist.
 *
 * @param props - Component props
 * @returns The signing sidebar
 */
import { DocumentField, Document } from '../../types';
import { CheckIcon } from '../icons/CheckIcon';

interface SigningSidebarProps {
  /** Available documents */
  documents: Document[];
  /** All fields to complete */
  fields: DocumentField[];
  /** Set of completed field IDs */
  completedFields: Set<string>;
  /** Currently selected document index */
  selectedDocIndex: number;
  /** Current page number */
  currentPage: number;
  /** Total pages in current document */
  numPages: number;
  /** Handler for document selection */
  onDocSelect: (index: number) => void;
  /** Handler for page changes */
  onPageChange: (page: number) => void;
  /** Handler for field click (navigation) */
  onFieldClick: (field: DocumentField) => void;
}

export function SigningSidebar({
  documents,
  fields,
  completedFields,
  selectedDocIndex,
  currentPage,
  numPages,
  onDocSelect,
  onPageChange,
  onFieldClick,
}: SigningSidebarProps) {
  return (
    <div className="col-span-1 space-y-4">
      {documents.length > 1 && (
        <DocumentSelector
          documents={documents}
          selectedIndex={selectedDocIndex}
          onSelect={onDocSelect}
          onPageChange={onPageChange}
        />
      )}

      <PageNavigation
        currentPage={currentPage}
        numPages={numPages}
        onPageChange={onPageChange}
      />

      <FieldsChecklist
        documents={documents}
        fields={fields}
        completedFields={completedFields}
        onFieldClick={onFieldClick}
      />
    </div>
  );
}

/**
 * Document selection dropdown.
 */
interface DocumentSelectorProps {
  documents: Document[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onPageChange: (page: number) => void;
}

function DocumentSelector({
  documents,
  selectedIndex,
  onSelect,
  onPageChange,
}: DocumentSelectorProps) {
  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onSelect(Number(e.target.value));
    onPageChange(1);
  };

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="font-medium mb-2">Documents</h3>
      <select
        value={selectedIndex}
        onChange={handleChange}
        className="w-full px-3 py-2 border rounded-lg"
      >
        {documents.map((doc, i) => (
          <option key={doc.id} value={i}>
            {doc.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Page navigation controls.
 */
interface PageNavigationProps {
  currentPage: number;
  numPages: number;
  onPageChange: (page: number) => void;
}

function PageNavigation({ currentPage, numPages, onPageChange }: PageNavigationProps) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="font-medium mb-2">
        Page {currentPage} of {numPages || '?'}
      </h3>
      <div className="flex space-x-2">
        <button
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
          disabled={currentPage <= 1}
          className="flex-1 px-3 py-2 border rounded-lg disabled:opacity-50"
        >
          Prev
        </button>
        <button
          onClick={() => onPageChange(Math.min(numPages, currentPage + 1))}
          disabled={currentPage >= numPages}
          className="flex-1 px-3 py-2 border rounded-lg disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}

/**
 * Checklist of fields to complete.
 */
interface FieldsChecklistProps {
  documents: Document[];
  fields: DocumentField[];
  completedFields: Set<string>;
  onFieldClick: (field: DocumentField) => void;
}

function FieldsChecklist({
  documents,
  fields,
  completedFields,
  onFieldClick,
}: FieldsChecklistProps) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="font-medium mb-2">Fields to Sign</h3>
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {fields.map((field) => (
          <FieldChecklistItem
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
 * Individual field checklist item.
 */
interface FieldChecklistItemProps {
  field: DocumentField;
  isCompleted: boolean;
  onClick: () => void;
}

function FieldChecklistItem({ field, isCompleted, onClick }: FieldChecklistItemProps) {
  const bgClass = isCompleted ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800';

  return (
    <button onClick={onClick} className={`w-full text-left p-2 rounded text-sm ${bgClass}`}>
      <div className="flex justify-between items-center">
        <span className="capitalize font-medium">{field.type}</span>
        {isCompleted ? (
          <CheckIcon className="w-4 h-4 text-green-600" />
        ) : (
          <span className="text-xs">Page {field.page_number}</span>
        )}
      </div>
    </button>
  );
}
