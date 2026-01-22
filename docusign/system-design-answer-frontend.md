# DocuSign - System Design Answer (Frontend Focus)

## 45-minute system design interview format - Frontend Engineer Position

---

## Introduction (2 minutes)

"Thank you for the opportunity. Today I'll design DocuSign, an electronic signature platform, with emphasis on the frontend architecture. This system is fascinating from a frontend perspective because it combines:

1. Complex document rendering with interactive overlays
2. Multi-step workflow UX with clear state communication
3. Signature capture using canvas APIs
4. Legal compliance requiring precise audit trail display

The frontend challenges include building a responsive PDF viewer with draggable field placement, a smooth signing ceremony experience, and accessible interfaces that work across devices.

Let me clarify the requirements."

---

## Requirements Clarification (4 minutes)

### User-Facing Requirements

"From a frontend perspective, we need to support:

1. **Document Preparation UI**: Upload PDFs, view pages, drag-and-drop field placement
2. **Recipient Management**: Add signers with routing order (serial/parallel)
3. **Signing Ceremony**: Step-by-step guided experience with signature capture
4. **Progress Tracking**: Visual indicators for envelope status and field completion
5. **Audit Trail Display**: Chronological event history with verification status

Two distinct user personas drive the design:
- **Senders**: Complex preparation UI with field placement tools
- **Signers**: Simple, focused signing experience without distractions"

### Frontend-Specific Non-Functional Requirements

"For the frontend specifically:

- **Performance**: PDF rendering under 2 seconds for typical documents
- **Accessibility**: WCAG 2.1 AA compliance for signing ceremony
- **Responsiveness**: Tablet-friendly signing (mobile is stretch goal)
- **Browser Support**: Modern browsers (Chrome, Firefox, Safari, Edge)
- **Offline Tolerance**: Graceful handling of network interruptions during signing"

---

## Component Architecture (10 minutes)

### High-Level Component Organization

```
frontend/src/
├── components/
│   ├── common/           # Shared UI primitives
│   │   ├── StatusBadge.tsx
│   │   ├── LoadingSpinner.tsx
│   │   ├── MessageBanner.tsx
│   │   └── index.ts
│   │
│   ├── envelope/         # Envelope preparation
│   │   ├── DocumentsTab.tsx
│   │   ├── RecipientsTab.tsx
│   │   ├── FieldsTab.tsx
│   │   ├── FieldsSidebar.tsx
│   │   ├── PdfViewer.tsx
│   │   ├── AuditTab.tsx
│   │   └── index.ts
│   │
│   ├── signing/          # Signing ceremony
│   │   ├── SigningHeader.tsx
│   │   ├── SigningSidebar.tsx
│   │   ├── SigningPdfViewer.tsx
│   │   ├── SignatureModal.tsx
│   │   └── index.ts
│   │
│   └── icons/            # SVG icons
│       ├── PdfIcon.tsx
│       ├── CheckIcon.tsx
│       └── index.ts
│
├── routes/               # TanStack Router pages
│   ├── envelopes/
│   │   ├── index.tsx
│   │   ├── new.tsx
│   │   └── $envelopeId.tsx
│   └── sign/
│       └── $accessToken.tsx
│
├── stores/               # Zustand state
│   ├── authStore.ts
│   └── envelopeStore.ts
│
└── services/             # API layer
    └── api.ts
```

### Common Components

"The common components provide consistent UI patterns across the application."

```typescript
// components/common/StatusBadge.tsx
interface StatusBadgeProps {
  status: 'draft' | 'sent' | 'delivered' | 'signed' | 'completed' | 'declined' | 'voided';
}

/**
 * Displays envelope status with appropriate color coding.
 * Colors align with DocuSign's established conventions.
 */
export function StatusBadge({ status }: StatusBadgeProps) {
  const colors: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-800',
    sent: 'bg-blue-100 text-blue-800',
    delivered: 'bg-yellow-100 text-yellow-800',
    signed: 'bg-green-100 text-green-800',
    completed: 'bg-green-200 text-green-900',
    declined: 'bg-red-100 text-red-800',
    voided: 'bg-gray-200 text-gray-600',
  };

  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${colors[status]}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}
```

```typescript
// components/common/LoadingSpinner.tsx
interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  centered?: boolean;
  message?: string;
}

/**
 * Accessible loading indicator with optional message.
 * Announces loading state to screen readers.
 */
export function LoadingSpinner({ size = 'md', centered = false, message }: LoadingSpinnerProps) {
  const sizes = { sm: 'h-4 w-4', md: 'h-8 w-8', lg: 'h-12 w-12' };

  return (
    <div
      className={centered ? 'flex flex-col items-center justify-center min-h-[200px]' : ''}
      role="status"
      aria-live="polite"
    >
      <svg className={`animate-spin ${sizes[size]} text-blue-600`} viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" opacity="0.25" />
        <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      {message && <p className="mt-2 text-gray-600">{message}</p>}
      <span className="sr-only">{message || 'Loading...'}</span>
    </div>
  );
}
```

```typescript
// components/common/MessageBanner.tsx
interface MessageBannerProps {
  type: 'error' | 'success' | 'info' | 'warning';
  message: string;
  onDismiss?: () => void;
}

/**
 * Alert banner for displaying status messages.
 * Includes dismiss functionality and appropriate ARIA roles.
 */
export function MessageBanner({ type, message, onDismiss }: MessageBannerProps) {
  const styles = {
    error: 'bg-red-50 text-red-800 border-red-200',
    success: 'bg-green-50 text-green-800 border-green-200',
    info: 'bg-blue-50 text-blue-800 border-blue-200',
    warning: 'bg-yellow-50 text-yellow-800 border-yellow-200',
  };

  return (
    <div
      className={`p-4 rounded-lg border ${styles[type]} flex justify-between items-center`}
      role={type === 'error' ? 'alert' : 'status'}
    >
      <span>{message}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="ml-4 text-current opacity-70 hover:opacity-100"
          aria-label="Dismiss message"
        >
          <CloseIcon className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}
```

---

## PDF Rendering and Field Placement (10 minutes)

### PDF Viewer Component

"PDF rendering is critical for the document preparation experience. We use react-pdf (PDF.js wrapper) for consistent cross-browser rendering."

```typescript
// components/envelope/PdfViewer.tsx
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc =
  `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface PdfViewerProps {
  documentUrl: string;
  currentPage: number;
  onPageChange: (page: number) => void;
  fields: DocumentField[];
  onFieldClick?: (field: DocumentField) => void;
  onPageClick?: (x: number, y: number) => void;
  selectedRecipientId?: string;
}

/**
 * PDF viewer with field overlay support.
 * Renders PDF pages and positions interactive field markers.
 */
export function PdfViewer({
  documentUrl,
  currentPage,
  onPageChange,
  fields,
  onFieldClick,
  onPageClick,
  selectedRecipientId,
}: PdfViewerProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [pageWidth, setPageWidth] = useState(700);
  const containerRef = useRef<HTMLDivElement>(null);

  // Responsive page width
  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        const width = Math.min(containerRef.current.offsetWidth - 48, 700);
        setPageWidth(width);
      }
    };
    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  const handlePageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onPageClick) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    onPageClick(x, y);
  };

  const currentPageFields = fields.filter(f => f.pageNumber === currentPage);

  return (
    <div ref={containerRef} className="flex flex-col items-center">
      {/* Page navigation */}
      <div className="flex items-center gap-4 mb-4">
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage <= 1}
          className="px-3 py-1 rounded bg-gray-100 disabled:opacity-50"
          aria-label="Previous page"
        >
          Previous
        </button>
        <span className="text-sm" aria-live="polite">
          Page {currentPage} of {numPages}
        </span>
        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= numPages}
          className="px-3 py-1 rounded bg-gray-100 disabled:opacity-50"
          aria-label="Next page"
        >
          Next
        </button>
      </div>

      {/* PDF with field overlays */}
      <div
        className="relative border shadow-lg"
        onClick={handlePageClick}
        role="img"
        aria-label={`Document page ${currentPage}`}
      >
        <Document
          file={documentUrl}
          onLoadSuccess={({ numPages }) => setNumPages(numPages)}
          loading={<LoadingSpinner centered message="Loading document..." />}
          error={<MessageBanner type="error" message="Failed to load PDF" />}
        >
          <Page pageNumber={currentPage} width={pageWidth} />
        </Document>

        {/* Field overlays */}
        {currentPageFields.map((field) => (
          <FieldOverlay
            key={field.id}
            field={field}
            onClick={() => onFieldClick?.(field)}
            isHighlighted={field.recipientId === selectedRecipientId}
          />
        ))}
      </div>
    </div>
  );
}
```

### Field Overlay Component

```typescript
// components/envelope/FieldOverlay.tsx
interface FieldOverlayProps {
  field: DocumentField;
  onClick?: () => void;
  isHighlighted?: boolean;
  isCompleted?: boolean;
}

/**
 * Positioned overlay for a document field.
 * Supports signature, initials, date, text, and checkbox types.
 */
export function FieldOverlay({ field, onClick, isHighlighted, isCompleted }: FieldOverlayProps) {
  const fieldIcons: Record<string, ReactNode> = {
    signature: <SignatureIcon className="h-4 w-4" />,
    initial: <InitialIcon className="h-4 w-4" />,
    date: <CalendarIcon className="h-4 w-4" />,
    text: <TextIcon className="h-4 w-4" />,
    checkbox: <CheckboxIcon className="h-4 w-4" />,
  };

  return (
    <button
      onClick={onClick}
      className={`
        absolute flex items-center justify-center
        border-2 border-dashed rounded
        transition-all duration-200
        ${isCompleted
          ? 'bg-green-100 border-green-500'
          : isHighlighted
            ? 'bg-yellow-100 border-yellow-500'
            : 'bg-blue-50 border-blue-300 hover:border-blue-500'
        }
      `}
      style={{
        left: `${field.x}%`,
        top: `${field.y}%`,
        width: `${field.width}%`,
        height: `${field.height}%`,
      }}
      aria-label={`${field.type} field${isCompleted ? ' (completed)' : ''}`}
    >
      {!isCompleted && fieldIcons[field.type]}
      {isCompleted && <CheckIcon className="h-4 w-4 text-green-600" />}
    </button>
  );
}
```

### Field Placement Sidebar

```typescript
// components/envelope/FieldsSidebar.tsx
interface FieldsSidebarProps {
  recipients: Recipient[];
  selectedRecipientId: string | null;
  onRecipientSelect: (id: string) => void;
  selectedFieldType: FieldType | null;
  onFieldTypeSelect: (type: FieldType) => void;
}

/**
 * Sidebar for field placement mode.
 * Allows selecting recipient and field type before clicking on PDF.
 */
export function FieldsSidebar({
  recipients,
  selectedRecipientId,
  onRecipientSelect,
  selectedFieldType,
  onFieldTypeSelect,
}: FieldsSidebarProps) {
  const fieldTypes: { type: FieldType; label: string; icon: ReactNode }[] = [
    { type: 'signature', label: 'Signature', icon: <SignatureIcon /> },
    { type: 'initial', label: 'Initials', icon: <InitialIcon /> },
    { type: 'date', label: 'Date Signed', icon: <CalendarIcon /> },
    { type: 'text', label: 'Text Input', icon: <TextIcon /> },
    { type: 'checkbox', label: 'Checkbox', icon: <CheckboxIcon /> },
  ];

  return (
    <aside className="w-64 border-r bg-gray-50 p-4" aria-label="Field placement tools">
      {/* Recipient selector */}
      <section className="mb-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">Assign to Recipient</h3>
        <div className="space-y-2">
          {recipients.map((recipient) => (
            <button
              key={recipient.id}
              onClick={() => onRecipientSelect(recipient.id)}
              className={`
                w-full text-left px-3 py-2 rounded
                ${selectedRecipientId === recipient.id
                  ? 'bg-blue-100 border-blue-500 border'
                  : 'bg-white border border-gray-200 hover:border-gray-400'
                }
              `}
              aria-pressed={selectedRecipientId === recipient.id}
            >
              <div className="font-medium text-sm">{recipient.name}</div>
              <div className="text-xs text-gray-500">{recipient.email}</div>
            </button>
          ))}
        </div>
      </section>

      {/* Field type selector */}
      <section>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">Field Type</h3>
        <div className="grid grid-cols-2 gap-2">
          {fieldTypes.map(({ type, label, icon }) => (
            <button
              key={type}
              onClick={() => onFieldTypeSelect(type)}
              disabled={!selectedRecipientId}
              className={`
                flex flex-col items-center p-3 rounded border
                ${selectedFieldType === type
                  ? 'bg-blue-100 border-blue-500'
                  : 'bg-white border-gray-200 hover:border-gray-400'
                }
                disabled:opacity-50 disabled:cursor-not-allowed
              `}
              aria-pressed={selectedFieldType === type}
            >
              {icon}
              <span className="text-xs mt-1">{label}</span>
            </button>
          ))}
        </div>
        {!selectedRecipientId && (
          <p className="text-xs text-gray-500 mt-2">
            Select a recipient first
          </p>
        )}
      </section>

      {/* Instructions */}
      {selectedRecipientId && selectedFieldType && (
        <div className="mt-6 p-3 bg-blue-50 rounded text-sm text-blue-800">
          Click on the document to place a {selectedFieldType} field for{' '}
          {recipients.find(r => r.id === selectedRecipientId)?.name}
        </div>
      )}
    </aside>
  );
}
```

---

## Signature Capture Modal (8 minutes)

### Signature Modal Component

"The signature modal provides draw and type modes for capturing signatures. Canvas-based drawing ensures consistent output across browsers."

```typescript
// components/signing/SignatureModal.tsx
import SignaturePad from 'signature_pad';

interface SignatureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (signatureData: { type: 'draw' | 'typed'; imageData: string }) => void;
  fieldType: 'signature' | 'initial';
}

/**
 * Modal for capturing signatures with draw or type modes.
 * Uses signature_pad for drawing, canvas rendering for typed text.
 */
export function SignatureModal({ isOpen, onClose, onConfirm, fieldType }: SignatureModalProps) {
  const [mode, setMode] = useState<'draw' | 'type'>('draw');
  const [typedText, setTypedText] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const signaturePadRef = useRef<SignaturePad | null>(null);
  const typedCanvasRef = useRef<HTMLCanvasElement>(null);

  // Initialize signature pad
  useEffect(() => {
    if (isOpen && canvasRef.current && mode === 'draw') {
      signaturePadRef.current = new SignaturePad(canvasRef.current, {
        backgroundColor: 'rgb(255, 255, 255)',
        penColor: 'rgb(0, 0, 0)',
      });
    }
    return () => {
      signaturePadRef.current?.off();
    };
  }, [isOpen, mode]);

  // Render typed signature to canvas
  useEffect(() => {
    if (mode === 'type' && typedCanvasRef.current && typedText) {
      const canvas = typedCanvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = 'black';
      ctx.font = '48px "Dancing Script", cursive';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(typedText, canvas.width / 2, canvas.height / 2);
    }
  }, [typedText, mode]);

  const handleClear = () => {
    if (mode === 'draw') {
      signaturePadRef.current?.clear();
    } else {
      setTypedText('');
    }
  };

  const handleConfirm = () => {
    let imageData: string;

    if (mode === 'draw') {
      if (signaturePadRef.current?.isEmpty()) {
        return; // Don't submit empty signature
      }
      imageData = signaturePadRef.current!.toDataURL('image/png');
    } else {
      if (!typedText.trim()) return;
      imageData = typedCanvasRef.current!.toDataURL('image/png');
    }

    onConfirm({ type: mode, imageData });
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="signature-modal-title"
    >
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 id="signature-modal-title" className="text-lg font-semibold">
            {fieldType === 'signature' ? 'Add Your Signature' : 'Add Your Initials'}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            aria-label="Close modal"
          >
            <CloseIcon className="h-6 w-6" />
          </button>
        </div>

        {/* Mode tabs */}
        <div className="flex border-b">
          <button
            onClick={() => setMode('draw')}
            className={`flex-1 py-3 text-center ${
              mode === 'draw'
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-500'
            }`}
            role="tab"
            aria-selected={mode === 'draw'}
          >
            Draw
          </button>
          <button
            onClick={() => setMode('type')}
            className={`flex-1 py-3 text-center ${
              mode === 'type'
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-500'
            }`}
            role="tab"
            aria-selected={mode === 'type'}
          >
            Type
          </button>
        </div>

        {/* Signature area */}
        <div className="p-4">
          {mode === 'draw' ? (
            <div className="border rounded bg-gray-50">
              <canvas
                ref={canvasRef}
                width={400}
                height={150}
                className="w-full cursor-crosshair"
                aria-label="Draw your signature here"
              />
            </div>
          ) : (
            <div className="space-y-4">
              <input
                type="text"
                value={typedText}
                onChange={(e) => setTypedText(e.target.value)}
                placeholder="Type your name"
                className="w-full px-4 py-2 border rounded focus:ring-2 focus:ring-blue-500"
                aria-label="Type your signature"
              />
              <div className="border rounded bg-gray-50">
                <canvas
                  ref={typedCanvasRef}
                  width={400}
                  height={150}
                  className="w-full"
                  aria-label="Signature preview"
                />
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-between p-4 border-t bg-gray-50">
          <button
            onClick={handleClear}
            className="px-4 py-2 text-gray-600 hover:text-gray-800"
          >
            Clear
          </button>
          <div className="space-x-2">
            <button
              onClick={onClose}
              className="px-4 py-2 border rounded hover:bg-gray-100"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Confirm
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

---

## Signing Ceremony Page (8 minutes)

### Signing Page Route

"The signing page provides a focused, guided experience for signers. We fetch the signing session using the access token, then render the document with interactive fields."

```typescript
// routes/sign/$accessToken.tsx
import { useParams } from '@tanstack/react-router';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  SigningHeader,
  SigningSidebar,
  SigningPdfViewer,
  SignatureModal,
  SigningLoadingState,
  SigningErrorState
} from '../../components/signing';

/**
 * Signing ceremony page.
 * Accessed via unique access token emailed to recipient.
 */
export default function SigningPage() {
  const { accessToken } = useParams({ from: '/sign/$accessToken' });
  const [showSignatureModal, setShowSignatureModal] = useState(false);
  const [activeField, setActiveField] = useState<DocumentField | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  // Fetch signing session
  const { data: session, isLoading, error, refetch } = useQuery({
    queryKey: ['signing-session', accessToken],
    queryFn: () => api.getSigningSession(accessToken),
  });

  // Submit signature mutation
  const signMutation = useMutation({
    mutationFn: (data: { fieldId: string; signatureData: SignatureData }) =>
      api.captureSignature(accessToken, data.fieldId, data.signatureData),
    onSuccess: () => {
      setShowSignatureModal(false);
      setActiveField(null);
      refetch(); // Refresh to show completed field
    },
  });

  // Complete signing mutation
  const completeMutation = useMutation({
    mutationFn: () => api.completeSigningSession(accessToken),
    onSuccess: () => {
      // Navigate to completion page or show success message
    },
  });

  if (isLoading) {
    return <SigningLoadingState message="Loading document..." />;
  }

  if (error || !session) {
    return (
      <SigningErrorState
        title="Unable to load document"
        message="This signing link may have expired or already been completed."
      />
    );
  }

  const { envelope, recipient, document, fields } = session;
  const myFields = fields.filter(f => f.recipientId === recipient.id);
  const completedCount = myFields.filter(f => f.completed).length;
  const totalRequired = myFields.filter(f => f.required).length;
  const allComplete = completedCount >= totalRequired;

  const handleFieldClick = (field: DocumentField) => {
    if (field.completed) return; // Already signed
    if (field.recipientId !== recipient.id) return; // Not my field

    setActiveField(field);
    if (field.type === 'signature' || field.type === 'initial') {
      setShowSignatureModal(true);
    }
  };

  const handleSignatureConfirm = (signatureData: SignatureData) => {
    if (!activeField) return;
    signMutation.mutate({ fieldId: activeField.id, signatureData });
  };

  return (
    <div className="min-h-screen flex flex-col bg-gray-100">
      <SigningHeader
        documentName={document.name}
        completedCount={completedCount}
        totalCount={totalRequired}
        onFinish={() => completeMutation.mutate()}
        canFinish={allComplete}
        isFinishing={completeMutation.isPending}
      />

      <div className="flex flex-1">
        <SigningSidebar
          fields={myFields}
          currentPage={currentPage}
          onFieldSelect={(field) => {
            setCurrentPage(field.pageNumber);
            handleFieldClick(field);
          }}
          completedCount={completedCount}
          totalCount={totalRequired}
        />

        <main className="flex-1 p-6">
          <SigningPdfViewer
            documentUrl={document.url}
            currentPage={currentPage}
            onPageChange={setCurrentPage}
            fields={myFields}
            onFieldClick={handleFieldClick}
          />
        </main>
      </div>

      <SignatureModal
        isOpen={showSignatureModal}
        onClose={() => {
          setShowSignatureModal(false);
          setActiveField(null);
        }}
        onConfirm={handleSignatureConfirm}
        fieldType={activeField?.type === 'initial' ? 'initial' : 'signature'}
      />
    </div>
  );
}
```

### Signing Sidebar Component

```typescript
// components/signing/SigningSidebar.tsx
interface SigningSidebarProps {
  fields: DocumentField[];
  currentPage: number;
  onFieldSelect: (field: DocumentField) => void;
  completedCount: number;
  totalCount: number;
}

/**
 * Navigation sidebar for signing ceremony.
 * Shows field checklist with completion status.
 */
export function SigningSidebar({
  fields,
  currentPage,
  onFieldSelect,
  completedCount,
  totalCount,
}: SigningSidebarProps) {
  const requiredFields = fields.filter(f => f.required);
  const optionalFields = fields.filter(f => !f.required);

  return (
    <aside
      className="w-72 bg-white border-r flex flex-col"
      aria-label="Signing progress"
    >
      {/* Progress indicator */}
      <div className="p-4 border-b">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium">Your Progress</span>
          <span className="text-sm text-gray-500">
            {completedCount} of {totalCount}
          </span>
        </div>
        <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-green-500 transition-all duration-300"
            style={{ width: `${(completedCount / totalCount) * 100}%` }}
            role="progressbar"
            aria-valuenow={completedCount}
            aria-valuemin={0}
            aria-valuemax={totalCount}
          />
        </div>
      </div>

      {/* Field list */}
      <div className="flex-1 overflow-y-auto p-4">
        <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">
          Required Fields
        </h3>
        <ul className="space-y-2 mb-4" role="list">
          {requiredFields.map((field, index) => (
            <li key={field.id}>
              <button
                onClick={() => onFieldSelect(field)}
                className={`
                  w-full flex items-center gap-3 p-3 rounded-lg text-left
                  ${field.completed
                    ? 'bg-green-50 border border-green-200'
                    : 'bg-gray-50 border border-gray-200 hover:border-blue-300'
                  }
                  ${field.pageNumber === currentPage ? 'ring-2 ring-blue-500' : ''}
                `}
                aria-label={`${field.type} on page ${field.pageNumber}${field.completed ? ', completed' : ''}`}
              >
                <span className={`
                  w-6 h-6 rounded-full flex items-center justify-center text-xs
                  ${field.completed
                    ? 'bg-green-500 text-white'
                    : 'bg-gray-300 text-gray-600'
                  }
                `}>
                  {field.completed ? <CheckIcon className="h-4 w-4" /> : index + 1}
                </span>
                <div className="flex-1">
                  <div className="text-sm font-medium capitalize">{field.type}</div>
                  <div className="text-xs text-gray-500">Page {field.pageNumber}</div>
                </div>
              </button>
            </li>
          ))}
        </ul>

        {optionalFields.length > 0 && (
          <>
            <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">
              Optional Fields
            </h3>
            <ul className="space-y-2" role="list">
              {optionalFields.map((field) => (
                <li key={field.id}>
                  {/* Similar structure but styled as optional */}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* Instructions */}
      <div className="p-4 border-t bg-blue-50">
        <p className="text-sm text-blue-800">
          Click on highlighted fields in the document or select from the list above.
        </p>
      </div>
    </aside>
  );
}
```

---

## State Management (5 minutes)

### Zustand Stores

```typescript
// stores/authStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
  id: string;
  email: string;
  name: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

/**
 * Authentication state store.
 * Persisted to localStorage for session continuity.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,

      login: async (email, password) => {
        const response = await api.login(email, password);
        set({
          user: response.user,
          token: response.token,
          isAuthenticated: true,
        });
      },

      logout: () => {
        set({ user: null, token: null, isAuthenticated: false });
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ token: state.token, user: state.user }),
    }
  )
);
```

```typescript
// stores/envelopeStore.ts
import { create } from 'zustand';

interface EnvelopeState {
  currentEnvelope: Envelope | null;
  isLoading: boolean;
  error: string | null;

  fetchEnvelope: (id: string) => Promise<void>;
  updateEnvelope: (updates: Partial<Envelope>) => Promise<void>;
  addRecipient: (recipient: Omit<Recipient, 'id'>) => Promise<void>;
  removeRecipient: (recipientId: string) => Promise<void>;
  addField: (field: Omit<DocumentField, 'id'>) => Promise<void>;
  removeField: (fieldId: string) => Promise<void>;
  sendEnvelope: () => Promise<void>;
  clearEnvelope: () => void;
}

/**
 * Envelope management store.
 * Handles CRUD operations for envelope preparation workflow.
 */
export const useEnvelopeStore = create<EnvelopeState>((set, get) => ({
  currentEnvelope: null,
  isLoading: false,
  error: null,

  fetchEnvelope: async (id) => {
    set({ isLoading: true, error: null });
    try {
      const envelope = await api.getEnvelope(id);
      set({ currentEnvelope: envelope, isLoading: false });
    } catch (error) {
      set({ error: 'Failed to load envelope', isLoading: false });
    }
  },

  updateEnvelope: async (updates) => {
    const { currentEnvelope } = get();
    if (!currentEnvelope) return;

    try {
      const updated = await api.updateEnvelope(currentEnvelope.id, updates);
      set({ currentEnvelope: updated });
    } catch (error) {
      set({ error: 'Failed to update envelope' });
    }
  },

  addRecipient: async (recipient) => {
    const { currentEnvelope } = get();
    if (!currentEnvelope) return;

    const newRecipient = await api.addRecipient(currentEnvelope.id, recipient);
    set({
      currentEnvelope: {
        ...currentEnvelope,
        recipients: [...currentEnvelope.recipients, newRecipient],
      },
    });
  },

  removeRecipient: async (recipientId) => {
    const { currentEnvelope } = get();
    if (!currentEnvelope) return;

    await api.removeRecipient(currentEnvelope.id, recipientId);
    set({
      currentEnvelope: {
        ...currentEnvelope,
        recipients: currentEnvelope.recipients.filter(r => r.id !== recipientId),
      },
    });
  },

  addField: async (field) => {
    const { currentEnvelope } = get();
    if (!currentEnvelope) return;

    const newField = await api.addField(currentEnvelope.documents[0].id, field);
    set({
      currentEnvelope: {
        ...currentEnvelope,
        documents: currentEnvelope.documents.map(doc => ({
          ...doc,
          fields: [...doc.fields, newField],
        })),
      },
    });
  },

  removeField: async (fieldId) => {
    const { currentEnvelope } = get();
    if (!currentEnvelope) return;

    await api.removeField(fieldId);
    set({
      currentEnvelope: {
        ...currentEnvelope,
        documents: currentEnvelope.documents.map(doc => ({
          ...doc,
          fields: doc.fields.filter(f => f.id !== fieldId),
        })),
      },
    });
  },

  sendEnvelope: async () => {
    const { currentEnvelope } = get();
    if (!currentEnvelope) return;

    await api.sendEnvelope(currentEnvelope.id);
    set({
      currentEnvelope: {
        ...currentEnvelope,
        status: 'sent',
      },
    });
  },

  clearEnvelope: () => {
    set({ currentEnvelope: null, error: null });
  },
}));
```

---

## Accessibility Considerations (3 minutes)

"Accessibility is critical for signing ceremonies - legal documents must be signable by everyone."

### Key Accessibility Features

1. **Keyboard Navigation**: All interactive elements focusable and operable via keyboard
2. **Screen Reader Support**: ARIA labels, live regions for status updates
3. **Focus Management**: Modal trapping, focus return after modal close
4. **Color Contrast**: WCAG AA compliant color combinations
5. **Error Messaging**: Clear, descriptive error messages linked to inputs

```typescript
// Example: Accessible field with error state
interface AccessibleFieldProps {
  id: string;
  label: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}

function AccessibleField({ id, label, error, required, children }: AccessibleFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700">
        {label}
        {required && <span className="text-red-500 ml-1" aria-hidden="true">*</span>}
        {required && <span className="sr-only">(required)</span>}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
```

---

## Trade-offs and Alternatives (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| PDF Rendering | react-pdf | PDF.js direct | Simpler React integration |
| Signature Capture | signature_pad | Fabric.js | Lightweight, purpose-built |
| State Management | Zustand | Redux | Less boilerplate, simpler API |
| Routing | TanStack Router | React Router | Type-safe, file-based routing |
| Styling | Tailwind CSS | CSS Modules | Rapid development, consistent design |

---

## Summary

"To summarize the frontend architecture for DocuSign:

1. **Component Organization**: Clear separation between common components, envelope preparation, and signing ceremony
2. **PDF Rendering**: react-pdf with interactive field overlays for document viewing
3. **Signature Capture**: Canvas-based drawing and typed signature modes
4. **State Management**: Zustand stores for authentication and envelope data
5. **Accessibility**: WCAG 2.1 AA compliance throughout signing flow
6. **Responsive Design**: Tablet-friendly layouts for on-the-go signing

The design prioritizes a focused, guided signing experience while providing powerful preparation tools for document senders.

What aspects would you like me to elaborate on?"
