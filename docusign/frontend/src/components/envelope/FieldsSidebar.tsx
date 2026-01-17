/**
 * Sidebar controls for the fields tab.
 * Includes document selector, page navigation, field placement, and fields list.
 *
 * @param props - Component props
 * @returns The fields sidebar controls
 */
import { DocumentField, Recipient } from '../../types';

interface DocumentItem {
  id: string;
  name: string;
}

interface FieldsSidebarProps {
  /** Available documents */
  documents: DocumentItem[];
  /** All recipients */
  recipients: Recipient[];
  /** All fields in the envelope */
  fields: DocumentField[];
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
  /** Handler for document selection */
  onDocSelect: (index: number) => void;
  /** Handler for page changes */
  onPageChange: (page: number) => void;
  /** Handler for recipient selection */
  onRecipientSelect: (id: string) => void;
  /** Handler for field type selection */
  onFieldTypeSelect: (type: string) => void;
  /** Handler for field deletion */
  onDeleteField: (id: string) => void;
}

export function FieldsSidebar({
  documents,
  recipients,
  fields,
  isDraft,
  selectedDocIndex,
  numPages,
  currentPage,
  selectedRecipient,
  selectedFieldType,
  onDocSelect,
  onPageChange,
  onRecipientSelect,
  onFieldTypeSelect,
  onDeleteField,
}: FieldsSidebarProps) {
  return (
    <div className="col-span-1 space-y-4">
      <DocumentSelector
        documents={documents}
        selectedIndex={selectedDocIndex}
        onSelect={(index) => {
          onDocSelect(index);
          onPageChange(1);
        }}
      />

      <PageNavigation
        currentPage={currentPage}
        numPages={numPages}
        onPageChange={onPageChange}
      />

      {isDraft && (
        <FieldPlacementControls
          recipients={recipients}
          selectedRecipient={selectedRecipient}
          selectedFieldType={selectedFieldType}
          onRecipientSelect={onRecipientSelect}
          onFieldTypeSelect={onFieldTypeSelect}
        />
      )}

      <FieldsList
        fields={fields}
        recipients={recipients}
        isDraft={isDraft}
        onDeleteField={onDeleteField}
      />
    </div>
  );
}

/**
 * Document selection dropdown.
 */
interface DocumentSelectorProps {
  documents: DocumentItem[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}

function DocumentSelector({ documents, selectedIndex, onSelect }: DocumentSelectorProps) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="font-medium mb-2">Document</h3>
      <select
        value={selectedIndex}
        onChange={(e) => onSelect(Number(e.target.value))}
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
 * Controls for placing new fields on the document.
 */
interface FieldPlacementControlsProps {
  recipients: Recipient[];
  selectedRecipient: string;
  selectedFieldType: string;
  onRecipientSelect: (id: string) => void;
  onFieldTypeSelect: (type: string) => void;
}

/** Available field types */
const FIELD_TYPES = [
  { value: 'signature', label: 'Signature' },
  { value: 'initial', label: 'Initial' },
  { value: 'date', label: 'Date' },
  { value: 'text', label: 'Text' },
  { value: 'checkbox', label: 'Checkbox' },
];

function FieldPlacementControls({
  recipients,
  selectedRecipient,
  selectedFieldType,
  onRecipientSelect,
  onFieldTypeSelect,
}: FieldPlacementControlsProps) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="font-medium mb-2">Add Field</h3>
      <select
        value={selectedRecipient}
        onChange={(e) => onRecipientSelect(e.target.value)}
        className="w-full px-3 py-2 border rounded-lg mb-2"
      >
        <option value="">Select recipient...</option>
        {recipients.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      <select
        value={selectedFieldType}
        onChange={(e) => onFieldTypeSelect(e.target.value)}
        className="w-full px-3 py-2 border rounded-lg"
      >
        {FIELD_TYPES.map((type) => (
          <option key={type.value} value={type.value}>
            {type.label}
          </option>
        ))}
      </select>
      <p className="text-xs text-gray-500 mt-2">
        {selectedRecipient
          ? 'Click on the document to place the field'
          : 'Select a recipient first'}
      </p>
    </div>
  );
}

/**
 * List of all fields in the envelope.
 */
interface FieldsListProps {
  fields: DocumentField[];
  recipients: Recipient[];
  isDraft: boolean;
  onDeleteField: (id: string) => void;
}

function FieldsList({ fields, recipients, isDraft, onDeleteField }: FieldsListProps) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="font-medium mb-2">Fields ({fields.length})</h3>
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {fields.map((field) => {
          const recipient = recipients.find((r) => r.id === field.recipient_id);
          return (
            <FieldListItem
              key={field.id}
              field={field}
              recipientName={recipient?.name}
              isDraft={isDraft}
              onDelete={onDeleteField}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * Individual field list item.
 */
interface FieldListItemProps {
  field: DocumentField;
  recipientName?: string;
  isDraft: boolean;
  onDelete: (id: string) => void;
}

function FieldListItem({ field, recipientName, isDraft, onDelete }: FieldListItemProps) {
  return (
    <div className="text-sm p-2 bg-gray-50 rounded flex justify-between items-center">
      <div>
        <span className="font-medium capitalize">{field.type}</span>
        <span className="text-gray-500"> - {recipientName || 'Unknown'}</span>
        <div className="text-xs text-gray-400">Page {field.page_number}</div>
      </div>
      {isDraft && (
        <button
          onClick={() => onDelete(field.id)}
          className="text-red-500 hover:text-red-700"
        >
          &times;
        </button>
      )}
    </div>
  );
}
