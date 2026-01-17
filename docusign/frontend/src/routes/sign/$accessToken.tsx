/**
 * Document signing page component.
 * Provides the signing ceremony interface for recipients to sign documents.
 *
 * Features:
 * - PDF document viewing with page navigation
 * - Interactive field overlays
 * - Draw or type signature capture
 * - Field completion tracking
 * - Finish or decline signing
 *
 * @returns The signing ceremony page
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { signingApi } from '../../services/api';
import { SigningSession, DocumentField } from '../../types';
import { pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Components
import { MessageBanner } from '../../components/common';
import {
  SigningHeader,
  SigningSidebar,
  SignatureModal,
  SigningPdfViewer,
  SigningLoadingState,
  SigningErrorState,
} from '../../components/signing';

// Set up PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

/**
 * Main signing page component.
 */
function SigningPage() {
  const { accessToken } = Route.useParams();
  const navigate = useNavigate();

  // Session state
  const [session, setSession] = useState<SigningSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Document viewing state
  const [selectedDocIndex, setSelectedDocIndex] = useState(0);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);

  // Signature modal state
  const [showSignatureModal, setShowSignatureModal] = useState(false);
  const [activeField, setActiveField] = useState<DocumentField | null>(null);

  // Completed fields tracking
  const [completedFields, setCompletedFields] = useState<Set<string>>(new Set());

  // Load session on mount
  useEffect(() => {
    loadSession();
  }, [accessToken]);

  /**
   * Loads the signing session from the API.
   */
  async function loadSession() {
    try {
      setLoading(true);
      const data = await signingApi.getSession(accessToken);
      setSession(data);

      // Track already completed fields
      const completed = new Set<string>();
      data.fields.forEach((f: DocumentField) => {
        if (f.completed) completed.add(f.id);
      });
      setCompletedFields(completed);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  /**
   * Opens the signature modal for a field.
   */
  function openSignatureModal(field: DocumentField) {
    setActiveField(field);
    setShowSignatureModal(true);
  }

  /**
   * Closes the signature modal.
   */
  function closeSignatureModal() {
    setShowSignatureModal(false);
    setActiveField(null);
  }

  /**
   * Handles signature submission.
   */
  async function handleSign(signatureData: string, signatureType: 'draw' | 'typed') {
    if (!activeField) return;

    setError('');
    try {
      await signingApi.sign(accessToken, activeField.id, signatureData, signatureType);
      setCompletedFields((prev) => new Set(prev).add(activeField.id));
      setSuccess('Signature captured!');
      setTimeout(() => setSuccess(''), 3000);
      closeSignatureModal();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * Handles completing a non-signature field.
   */
  async function handleCompleteField(field: DocumentField, value?: string) {
    setError('');
    try {
      await signingApi.completeField(accessToken, field.id, value);
      setCompletedFields((prev) => new Set(prev).add(field.id));
      setSuccess('Field completed!');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * Handles field click based on field type.
   */
  function handleFieldClick(field: DocumentField) {
    const isCompleted = completedFields.has(field.id);
    if (isCompleted) return;

    if (['signature', 'initial'].includes(field.type)) {
      openSignatureModal(field);
    } else if (field.type === 'date') {
      handleCompleteField(field, new Date().toISOString().split('T')[0]);
    } else if (field.type === 'checkbox') {
      handleCompleteField(field, 'checked');
    } else {
      const value = prompt('Enter text:');
      if (value) handleCompleteField(field, value);
    }
  }

  /**
   * Handles finishing the signing ceremony.
   */
  async function handleFinish() {
    const incompleteCount = session!.fields.filter(
      (f) => f.required && !completedFields.has(f.id)
    ).length;

    if (incompleteCount > 0) {
      setError(`Please complete all ${incompleteCount} required fields before finishing.`);
      return;
    }

    if (!confirm('Are you sure you want to finish signing?')) return;

    setError('');
    try {
      await signingApi.finish(accessToken);
      setSuccess('Signing completed successfully!');
      setTimeout(() => {
        navigate({ to: '/signing-complete' });
      }, 2000);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * Handles declining the document.
   */
  async function handleDecline() {
    const reason = prompt('Please provide a reason for declining (optional):');
    if (reason === null) return; // User cancelled

    try {
      await signingApi.decline(accessToken, reason);
      setSuccess('Document declined.');
      setTimeout(() => {
        navigate({ to: '/signing-declined' });
      }, 2000);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * Navigates to a specific field's location.
   */
  function handleFieldNavigation(field: DocumentField) {
    const docIndex = session!.documents.findIndex((d) => d.id === field.document_id);
    setSelectedDocIndex(docIndex);
    setCurrentPage(field.page_number);
  }

  // Loading state
  if (loading) {
    return <SigningLoadingState />;
  }

  // Error state (no session loaded)
  if (error && !session) {
    return <SigningErrorState error={error} />;
  }

  // Should not happen, but guard
  if (!session) return null;

  // Computed values
  const currentDoc = session.documents[selectedDocIndex];
  const currentPageFields = session.fields.filter(
    (f) => f.document_id === currentDoc?.id && f.page_number === currentPage
  );
  const completedCount = completedFields.size;
  const totalRequiredCount = session.fields.filter((f) => f.required).length;

  return (
    <div className="min-h-screen bg-gray-100">
      <SigningHeader
        envelopeName={session.envelope.name}
        recipientName={session.recipient.name}
        completedCount={completedCount}
        totalRequiredCount={totalRequiredCount}
        onDecline={handleDecline}
        onFinish={handleFinish}
      />

      {error && (
        <div className="max-w-7xl mx-auto px-4 mt-4">
          <MessageBanner type="error" message={error} />
        </div>
      )}
      {success && (
        <div className="max-w-7xl mx-auto px-4 mt-4">
          <MessageBanner type="success" message={success} />
        </div>
      )}

      {session.envelope.message && (
        <div className="max-w-7xl mx-auto px-4 mt-4">
          <MessageBanner type="info" message={session.envelope.message} />
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-4 gap-6">
          <SigningSidebar
            documents={session.documents}
            fields={session.fields}
            completedFields={completedFields}
            selectedDocIndex={selectedDocIndex}
            currentPage={currentPage}
            numPages={numPages}
            onDocSelect={setSelectedDocIndex}
            onPageChange={setCurrentPage}
            onFieldClick={handleFieldNavigation}
          />

          <SigningPdfViewer
            documentUrl={signingApi.getDocument(accessToken, currentDoc.id)}
            currentPage={currentPage}
            onLoadSuccess={setNumPages}
            currentPageFields={currentPageFields}
            completedFields={completedFields}
            onFieldClick={handleFieldClick}
          />
        </div>
      </div>

      <SignatureModal
        isOpen={showSignatureModal}
        activeField={activeField}
        onClose={closeSignatureModal}
        onSign={handleSign}
        error={error}
      />
    </div>
  );
}

export const Route = createFileRoute('/sign/$accessToken')({
  component: SigningPage,
});
