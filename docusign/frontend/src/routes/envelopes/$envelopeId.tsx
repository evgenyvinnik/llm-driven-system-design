/**
 * Envelope detail page component.
 * Displays and manages a single envelope with its documents, recipients, fields, and audit trail.
 *
 * Features:
 * - Document upload and management
 * - Recipient management with routing order
 * - Field placement on PDF documents
 * - Audit trail with hash chain verification
 * - Send and void envelope actions
 *
 * @returns The envelope detail page
 */
import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useEffect, useState, useRef } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { useEnvelopeStore } from '../../stores/envelopeStore';
import { auditApi } from '../../services/api';
import { AuditEvent } from '../../types';
import { pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Components
import { StatusBadge, LoadingSpinner, MessageBanner } from '../../components/common';
import { DocumentsTab, RecipientsTab, FieldsTab, AuditTab } from '../../components/envelope';

// Set up PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

/** Available tab options */
type TabType = 'documents' | 'recipients' | 'fields' | 'audit';

/**
 * Main envelope detail page component.
 */
function EnvelopeDetailPage() {
  const { envelopeId } = Route.useParams();
  const { isAuthenticated, isLoading: authLoading } = useAuthStore();
  const {
    currentEnvelope,
    documents,
    recipients,
    fields,
    isLoading,
    fetchEnvelope,
    uploadDocument,
    deleteDocument,
    addRecipient,
    deleteRecipient,
    addField,
    deleteField,
    sendEnvelope,
    voidEnvelope,
    clearCurrent,
  } = useEnvelopeStore();
  const navigate = useNavigate();

  // UI state
  const [activeTab, setActiveTab] = useState<TabType>('documents');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Audit state
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditVerified, setAuditVerified] = useState<boolean | null>(null);

  // Recipient form state
  const [newRecipientName, setNewRecipientName] = useState('');
  const [newRecipientEmail, setNewRecipientEmail] = useState('');

  // PDF viewer state
  const [selectedDocIndex, setSelectedDocIndex] = useState(0);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedRecipient, setSelectedRecipient] = useState<string>('');
  const [selectedFieldType, setSelectedFieldType] = useState<string>('signature');
  const pdfContainerRef = useRef<HTMLDivElement>(null);

  // Redirect if not authenticated
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login' });
    }
  }, [isAuthenticated, authLoading, navigate]);

  // Fetch envelope data
  useEffect(() => {
    if (isAuthenticated && envelopeId) {
      fetchEnvelope(envelopeId);
    }
    return () => clearCurrent();
  }, [isAuthenticated, envelopeId, fetchEnvelope, clearCurrent]);

  // Load audit events when audit tab is active
  useEffect(() => {
    if (activeTab === 'audit' && envelopeId) {
      loadAuditEvents();
    }
  }, [activeTab, envelopeId]);

  /**
   * Loads audit events and verifies the hash chain.
   */
  async function loadAuditEvents() {
    try {
      const [eventsRes, verifyRes] = await Promise.all([
        auditApi.getEvents(envelopeId),
        auditApi.verify(envelopeId),
      ]);
      setAuditEvents(eventsRes.events);
      setAuditVerified(verifyRes.verification.valid);
    } catch (err) {
      console.error('Failed to load audit events:', err);
    }
  }

  /**
   * Handles PDF file upload.
   */
  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setError('');
    try {
      await uploadDocument(envelopeId, file);
      setSuccess('Document uploaded successfully');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError((err as Error).message);
    }
    e.target.value = '';
  }

  /**
   * Handles document deletion with confirmation.
   */
  async function handleDeleteDocument(id: string) {
    if (!confirm('Delete this document?')) return;
    try {
      await deleteDocument(id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * Handles adding a new recipient.
   */
  async function handleAddRecipient(e: React.FormEvent) {
    e.preventDefault();
    if (!newRecipientName.trim() || !newRecipientEmail.trim()) return;

    try {
      const routingOrder = recipients.length + 1;
      await addRecipient(envelopeId, {
        name: newRecipientName.trim(),
        email: newRecipientEmail.trim(),
        routingOrder,
      });
      setNewRecipientName('');
      setNewRecipientEmail('');
      setSuccess('Recipient added');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * Handles recipient deletion with confirmation.
   */
  async function handleDeleteRecipient(id: string) {
    if (!confirm('Delete this recipient?')) return;
    try {
      await deleteRecipient(id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * Handles field placement on document click.
   */
  async function handleAddField(e: React.MouseEvent<HTMLDivElement>) {
    if (!selectedRecipient || documents.length === 0) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    try {
      await addField(documents[selectedDocIndex].id, {
        recipientId: selectedRecipient,
        type: selectedFieldType,
        pageNumber: currentPage,
        x,
        y,
      });
      setSuccess('Field added');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * Handles field deletion.
   */
  async function handleDeleteField(id: string) {
    try {
      await deleteField(id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * Sends the envelope for signing with confirmation.
   */
  async function handleSendEnvelope() {
    if (!confirm('Send this envelope for signing?')) return;
    setError('');
    try {
      await sendEnvelope(envelopeId);
      setSuccess('Envelope sent successfully!');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * Voids the envelope with a reason prompt.
   */
  async function handleVoidEnvelope() {
    const reason = prompt('Reason for voiding:');
    if (!reason) return;

    try {
      await voidEnvelope(envelopeId, reason);
      setSuccess('Envelope voided');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Loading state
  if (authLoading || isLoading || !currentEnvelope) {
    return <LoadingSpinner centered />;
  }

  const isDraft = currentEnvelope.status === 'draft';
  const currentDoc = documents[selectedDocIndex];
  const currentPageFields = fields.filter(
    (f) => f.document_id === currentDoc?.id && f.page_number === currentPage
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <EnvelopeHeader
        envelope={currentEnvelope}
        isDraft={isDraft}
        onSend={handleSendEnvelope}
        onVoid={handleVoidEnvelope}
      />

      {error && <MessageBanner type="error" message={error} className="mb-4" />}
      {success && <MessageBanner type="success" message={success} className="mb-4" />}

      <TabNavigation
        activeTab={activeTab}
        onTabChange={setActiveTab}
        documentCount={documents.length}
        recipientCount={recipients.length}
        fieldCount={fields.length}
      />

      {activeTab === 'documents' && (
        <DocumentsTab
          documents={documents}
          isDraft={isDraft}
          onUpload={handleFileUpload}
          onDelete={handleDeleteDocument}
        />
      )}

      {activeTab === 'recipients' && (
        <RecipientsTab
          recipients={recipients}
          isDraft={isDraft}
          newName={newRecipientName}
          newEmail={newRecipientEmail}
          onNameChange={setNewRecipientName}
          onEmailChange={setNewRecipientEmail}
          onAdd={handleAddRecipient}
          onDelete={handleDeleteRecipient}
        />
      )}

      {activeTab === 'fields' && (
        <FieldsTab
          documents={documents}
          recipients={recipients}
          fields={fields}
          currentPageFields={currentPageFields}
          isDraft={isDraft}
          selectedDocIndex={selectedDocIndex}
          numPages={numPages}
          currentPage={currentPage}
          selectedRecipient={selectedRecipient}
          selectedFieldType={selectedFieldType}
          pdfContainerRef={pdfContainerRef}
          onDocSelect={setSelectedDocIndex}
          onPageLoad={setNumPages}
          onPageChange={setCurrentPage}
          onRecipientSelect={setSelectedRecipient}
          onFieldTypeSelect={setSelectedFieldType}
          onAddField={handleAddField}
          onDeleteField={handleDeleteField}
        />
      )}

      {activeTab === 'audit' && (
        <AuditTab events={auditEvents} verified={auditVerified} />
      )}
    </div>
  );
}

/**
 * Envelope header with title, status, and action buttons.
 */
interface EnvelopeHeaderProps {
  envelope: {
    name: string;
    status: string;
    created_at: string;
  };
  isDraft: boolean;
  onSend: () => void;
  onVoid: () => void;
}

function EnvelopeHeader({ envelope, isDraft, onSend, onVoid }: EnvelopeHeaderProps) {
  const canVoid = ['sent', 'delivered'].includes(envelope.status);

  return (
    <div className="flex justify-between items-start mb-6">
      <div>
        <Link
          to="/envelopes"
          className="text-docusign-blue hover:underline text-sm mb-2 block"
        >
          &larr; Back to Envelopes
        </Link>
        <h1 className="text-2xl font-bold text-gray-900">{envelope.name}</h1>
        <div className="flex items-center space-x-4 mt-2">
          <StatusBadge status={envelope.status} />
          <span className="text-sm text-gray-500">
            Created {new Date(envelope.created_at).toLocaleDateString()}
          </span>
        </div>
      </div>
      <div className="flex space-x-3">
        {isDraft && (
          <button
            onClick={onSend}
            className="bg-docusign-blue text-white px-4 py-2 rounded-lg font-medium hover:bg-docusign-dark"
          >
            Send Envelope
          </button>
        )}
        {canVoid && (
          <button
            onClick={onVoid}
            className="border border-red-300 text-red-600 px-4 py-2 rounded-lg font-medium hover:bg-red-50"
          >
            Void
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Tab navigation component.
 */
interface TabNavigationProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  documentCount: number;
  recipientCount: number;
  fieldCount: number;
}

function TabNavigation({
  activeTab,
  onTabChange,
  documentCount,
  recipientCount,
  fieldCount,
}: TabNavigationProps) {
  const tabs: { key: TabType; label: string; count?: number }[] = [
    { key: 'documents', label: 'Documents', count: documentCount },
    { key: 'recipients', label: 'Recipients', count: recipientCount },
    { key: 'fields', label: 'Fields', count: fieldCount },
    { key: 'audit', label: 'Audit' },
  ];

  return (
    <div className="border-b mb-6">
      <nav className="flex space-x-8">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => onTabChange(tab.key)}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                isActive
                  ? 'border-docusign-blue text-docusign-blue'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
              {tab.count !== undefined && ` (${tab.count})`}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

export const Route = createFileRoute('/envelopes/$envelopeId')({
  component: EnvelopeDetailPage,
});
