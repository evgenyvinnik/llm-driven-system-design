import { createFileRoute, useNavigate, Link } from '@tanstack/react-router'
import { useEffect, useState, useRef } from 'react'
import { useAuthStore } from '../../stores/authStore'
import { useEnvelopeStore } from '../../stores/envelopeStore'
import { auditApi } from '../../services/api'
import { AuditEvent, DocumentField, Recipient } from '../../types'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

// Set up PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`

function EnvelopeDetailPage() {
  const { envelopeId } = Route.useParams()
  const { isAuthenticated, isLoading: authLoading } = useAuthStore()
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
  } = useEnvelopeStore()
  const navigate = useNavigate()

  const [activeTab, setActiveTab] = useState<'documents' | 'recipients' | 'fields' | 'audit'>('documents')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([])
  const [auditVerified, setAuditVerified] = useState<boolean | null>(null)

  // New recipient form
  const [newRecipientName, setNewRecipientName] = useState('')
  const [newRecipientEmail, setNewRecipientEmail] = useState('')

  // PDF viewer state
  const [selectedDocIndex, setSelectedDocIndex] = useState(0)
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [selectedRecipient, setSelectedRecipient] = useState<string>('')
  const [selectedFieldType, setSelectedFieldType] = useState<string>('signature')
  const pdfContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login' })
    }
  }, [isAuthenticated, authLoading, navigate])

  useEffect(() => {
    if (isAuthenticated && envelopeId) {
      fetchEnvelope(envelopeId)
    }
    return () => clearCurrent()
  }, [isAuthenticated, envelopeId, fetchEnvelope, clearCurrent])

  useEffect(() => {
    if (activeTab === 'audit' && envelopeId) {
      loadAuditEvents()
    }
  }, [activeTab, envelopeId])

  async function loadAuditEvents() {
    try {
      const [eventsRes, verifyRes] = await Promise.all([
        auditApi.getEvents(envelopeId),
        auditApi.verify(envelopeId),
      ])
      setAuditEvents(eventsRes.events)
      setAuditVerified(verifyRes.verification.valid)
    } catch (err) {
      console.error('Failed to load audit events:', err)
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setError('')
    try {
      await uploadDocument(envelopeId, file)
      setSuccess('Document uploaded successfully')
      setTimeout(() => setSuccess(''), 3000)
    } catch (err) {
      setError((err as Error).message)
    }
    e.target.value = ''
  }

  async function handleDeleteDocument(id: string) {
    if (!confirm('Delete this document?')) return
    try {
      await deleteDocument(id)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function handleAddRecipient(e: React.FormEvent) {
    e.preventDefault()
    if (!newRecipientName.trim() || !newRecipientEmail.trim()) return

    try {
      const routingOrder = recipients.length + 1
      await addRecipient(envelopeId, {
        name: newRecipientName.trim(),
        email: newRecipientEmail.trim(),
        routingOrder,
      })
      setNewRecipientName('')
      setNewRecipientEmail('')
      setSuccess('Recipient added')
      setTimeout(() => setSuccess(''), 3000)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function handleDeleteRecipient(id: string) {
    if (!confirm('Delete this recipient?')) return
    try {
      await deleteRecipient(id)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function handleAddField(e: React.MouseEvent<HTMLDivElement>) {
    if (!selectedRecipient || documents.length === 0) return

    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    try {
      await addField(documents[selectedDocIndex].id, {
        recipientId: selectedRecipient,
        type: selectedFieldType,
        pageNumber: currentPage,
        x,
        y,
      })
      setSuccess('Field added')
      setTimeout(() => setSuccess(''), 3000)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function handleDeleteField(id: string) {
    try {
      await deleteField(id)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function handleSendEnvelope() {
    if (!confirm('Send this envelope for signing?')) return
    setError('')
    try {
      await sendEnvelope(envelopeId)
      setSuccess('Envelope sent successfully!')
      setTimeout(() => setSuccess(''), 3000)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function handleVoidEnvelope() {
    const reason = prompt('Reason for voiding:')
    if (!reason) return

    try {
      await voidEnvelope(envelopeId, reason)
      setSuccess('Envelope voided')
      setTimeout(() => setSuccess(''), 3000)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (authLoading || isLoading || !currentEnvelope) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-gray-300 border-t-docusign-blue rounded-full spinner" />
      </div>
    )
  }

  const isDraft = currentEnvelope.status === 'draft'
  const currentDoc = documents[selectedDocIndex]
  const currentPageFields = fields.filter(
    (f) => f.document_id === currentDoc?.id && f.page_number === currentPage
  )

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <Link to="/envelopes" className="text-docusign-blue hover:underline text-sm mb-2 block">
            &larr; Back to Envelopes
          </Link>
          <h1 className="text-2xl font-bold text-gray-900">{currentEnvelope.name}</h1>
          <div className="flex items-center space-x-4 mt-2">
            <StatusBadge status={currentEnvelope.status} />
            <span className="text-sm text-gray-500">
              Created {new Date(currentEnvelope.created_at).toLocaleDateString()}
            </span>
          </div>
        </div>
        <div className="flex space-x-3">
          {isDraft && (
            <button
              onClick={handleSendEnvelope}
              className="bg-docusign-blue text-white px-4 py-2 rounded-lg font-medium hover:bg-docusign-dark"
            >
              Send Envelope
            </button>
          )}
          {['sent', 'delivered'].includes(currentEnvelope.status) && (
            <button
              onClick={handleVoidEnvelope}
              className="border border-red-300 text-red-600 px-4 py-2 rounded-lg font-medium hover:bg-red-50"
            >
              Void
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      {error && (
        <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm">{error}</div>
      )}
      {success && (
        <div className="bg-green-50 text-green-600 p-3 rounded-lg mb-4 text-sm">{success}</div>
      )}

      {/* Tabs */}
      <div className="border-b mb-6">
        <nav className="flex space-x-8">
          {['documents', 'recipients', 'fields', 'audit'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab as typeof activeTab)}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === tab
                  ? 'border-docusign-blue text-docusign-blue'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
              {tab === 'documents' && ` (${documents.length})`}
              {tab === 'recipients' && ` (${recipients.length})`}
              {tab === 'fields' && ` (${fields.length})`}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
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
  )
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-800',
    sent: 'bg-blue-100 text-blue-800',
    delivered: 'bg-blue-100 text-blue-800',
    signed: 'bg-yellow-100 text-yellow-800',
    completed: 'bg-green-100 text-green-800',
    declined: 'bg-red-100 text-red-800',
    voided: 'bg-gray-100 text-gray-800',
  }
  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-100'}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  )
}

function DocumentsTab({
  documents,
  isDraft,
  onUpload,
  onDelete,
}: {
  documents: { id: string; name: string; page_count: number; file_size: number }[]
  isDraft: boolean
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void
  onDelete: (id: string) => void
}) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">Documents</h2>
        {isDraft && (
          <label className="bg-docusign-blue text-white px-4 py-2 rounded-lg font-medium hover:bg-docusign-dark cursor-pointer">
            Upload PDF
            <input type="file" accept=".pdf" onChange={onUpload} className="hidden" />
          </label>
        )}
      </div>

      {documents.length === 0 ? (
        <p className="text-gray-500 text-center py-8">No documents uploaded yet.</p>
      ) : (
        <div className="space-y-3">
          {documents.map((doc) => (
            <div key={doc.id} className="flex items-center justify-between p-4 border rounded-lg">
              <div className="flex items-center space-x-4">
                <svg className="w-8 h-8 text-red-500" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"
                    clipRule="evenodd"
                  />
                </svg>
                <div>
                  <div className="font-medium">{doc.name}</div>
                  <div className="text-sm text-gray-500">
                    {doc.page_count} pages | {Math.round(doc.file_size / 1024)} KB
                  </div>
                </div>
              </div>
              {isDraft && (
                <button onClick={() => onDelete(doc.id)} className="text-red-600 hover:text-red-900 text-sm">
                  Delete
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RecipientsTab({
  recipients,
  isDraft,
  newName,
  newEmail,
  onNameChange,
  onEmailChange,
  onAdd,
  onDelete,
}: {
  recipients: Recipient[]
  isDraft: boolean
  newName: string
  newEmail: string
  onNameChange: (v: string) => void
  onEmailChange: (v: string) => void
  onAdd: (e: React.FormEvent) => void
  onDelete: (id: string) => void
}) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold mb-4">Recipients</h2>

      {isDraft && (
        <form onSubmit={onAdd} className="flex space-x-4 mb-6">
          <input
            type="text"
            placeholder="Name"
            value={newName}
            onChange={(e) => onNameChange(e.target.value)}
            className="flex-1 px-3 py-2 border rounded-lg focus:ring-2 focus:ring-docusign-blue"
            required
          />
          <input
            type="email"
            placeholder="Email"
            value={newEmail}
            onChange={(e) => onEmailChange(e.target.value)}
            className="flex-1 px-3 py-2 border rounded-lg focus:ring-2 focus:ring-docusign-blue"
            required
          />
          <button
            type="submit"
            className="bg-docusign-blue text-white px-4 py-2 rounded-lg font-medium hover:bg-docusign-dark"
          >
            Add Recipient
          </button>
        </form>
      )}

      {recipients.length === 0 ? (
        <p className="text-gray-500 text-center py-8">No recipients added yet.</p>
      ) : (
        <div className="space-y-3">
          {recipients.map((recipient, index) => (
            <div key={recipient.id} className="flex items-center justify-between p-4 border rounded-lg">
              <div className="flex items-center space-x-4">
                <div className="w-8 h-8 bg-docusign-blue text-white rounded-full flex items-center justify-center font-medium">
                  {index + 1}
                </div>
                <div>
                  <div className="font-medium">{recipient.name}</div>
                  <div className="text-sm text-gray-500">{recipient.email}</div>
                </div>
                <StatusBadge status={recipient.status} />
              </div>
              {isDraft && (
                <button
                  onClick={() => onDelete(recipient.id)}
                  className="text-red-600 hover:text-red-900 text-sm"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function FieldsTab({
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
}: {
  documents: { id: string; name: string }[]
  recipients: Recipient[]
  fields: DocumentField[]
  currentPageFields: DocumentField[]
  isDraft: boolean
  selectedDocIndex: number
  numPages: number
  currentPage: number
  selectedRecipient: string
  selectedFieldType: string
  pdfContainerRef: React.RefObject<HTMLDivElement>
  onDocSelect: (i: number) => void
  onPageLoad: (n: number) => void
  onPageChange: (p: number) => void
  onRecipientSelect: (id: string) => void
  onFieldTypeSelect: (t: string) => void
  onAddField: (e: React.MouseEvent<HTMLDivElement>) => void
  onDeleteField: (id: string) => void
}) {
  const currentDoc = documents[selectedDocIndex]

  if (documents.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
        Please upload a document first.
      </div>
    )
  }

  if (recipients.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
        Please add at least one recipient first.
      </div>
    )
  }

  return (
    <div className="grid grid-cols-4 gap-6">
      {/* Sidebar */}
      <div className="col-span-1 space-y-4">
        {/* Document selector */}
        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="font-medium mb-2">Document</h3>
          <select
            value={selectedDocIndex}
            onChange={(e) => {
              onDocSelect(Number(e.target.value))
              onPageChange(1)
            }}
            className="w-full px-3 py-2 border rounded-lg"
          >
            {documents.map((doc, i) => (
              <option key={doc.id} value={i}>
                {doc.name}
              </option>
            ))}
          </select>
        </div>

        {/* Page navigation */}
        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="font-medium mb-2">Page {currentPage} of {numPages || '?'}</h3>
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

        {/* Field placement (only for draft) */}
        {isDraft && (
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
              <option value="signature">Signature</option>
              <option value="initial">Initial</option>
              <option value="date">Date</option>
              <option value="text">Text</option>
              <option value="checkbox">Checkbox</option>
            </select>
            <p className="text-xs text-gray-500 mt-2">
              {selectedRecipient ? 'Click on the document to place the field' : 'Select a recipient first'}
            </p>
          </div>
        )}

        {/* Fields list */}
        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="font-medium mb-2">Fields ({fields.length})</h3>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {fields.map((field) => {
              const recipient = recipients.find((r) => r.id === field.recipient_id)
              return (
                <div key={field.id} className="text-sm p-2 bg-gray-50 rounded flex justify-between items-center">
                  <div>
                    <span className="font-medium capitalize">{field.type}</span>
                    <span className="text-gray-500"> - {recipient?.name || 'Unknown'}</span>
                    <div className="text-xs text-gray-400">Page {field.page_number}</div>
                  </div>
                  {isDraft && (
                    <button
                      onClick={() => onDeleteField(field.id)}
                      className="text-red-500 hover:text-red-700"
                    >
                      &times;
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* PDF viewer */}
      <div className="col-span-3 bg-white rounded-lg shadow p-4">
        <div
          ref={pdfContainerRef}
          className="relative border rounded-lg overflow-hidden bg-gray-100"
          onClick={isDraft && selectedRecipient ? onAddField : undefined}
          style={{ cursor: isDraft && selectedRecipient ? 'crosshair' : 'default' }}
        >
          <Document
            file={`/api/v1/documents/${currentDoc.id}/view`}
            onLoadSuccess={({ numPages }) => onPageLoad(numPages)}
            loading={
              <div className="flex items-center justify-center h-96">
                <div className="w-8 h-8 border-4 border-gray-300 border-t-docusign-blue rounded-full spinner" />
              </div>
            }
          >
            <Page pageNumber={currentPage} width={700} />
          </Document>

          {/* Render field overlays */}
          {currentPageFields.map((field) => {
            const recipient = recipients.find((r) => r.id === field.recipient_id)
            const colorClass = getFieldColorClass(field.type)
            return (
              <div
                key={field.id}
                className={`field-highlight ${field.type} ${field.completed ? 'completed' : ''}`}
                style={{
                  left: field.x,
                  top: field.y,
                  width: field.width,
                  height: field.height,
                }}
                title={`${field.type} - ${recipient?.name || 'Unknown'}`}
              >
                {field.completed && (
                  <span className="absolute inset-0 flex items-center justify-center text-green-600 text-xs font-medium">
                    Done
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function getFieldColorClass(type: string) {
  const colors: Record<string, string> = {
    signature: 'border-amber-500',
    initial: 'border-purple-500',
    date: 'border-green-500',
    text: 'border-blue-500',
    checkbox: 'border-indigo-500',
  }
  return colors[type] || 'border-gray-500'
}

function AuditTab({ events, verified }: { events: AuditEvent[]; verified: boolean | null }) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">Audit Trail</h2>
        {verified !== null && (
          <span
            className={`px-3 py-1 rounded-full text-sm font-medium ${
              verified ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
            }`}
          >
            {verified ? 'Chain Verified' : 'Chain Invalid'}
          </span>
        )}
      </div>

      {events.length === 0 ? (
        <p className="text-gray-500 text-center py-8">No audit events yet.</p>
      ) : (
        <div className="space-y-3">
          {events.map((event) => (
            <div key={event.id} className="flex items-start space-x-4 p-4 border rounded-lg">
              <div className="w-2 h-2 mt-2 bg-docusign-blue rounded-full" />
              <div className="flex-1">
                <div className="flex justify-between">
                  <span className="font-medium">{event.details || event.type}</span>
                  <span className="text-sm text-gray-500">
                    {new Date(event.timestamp).toLocaleString()}
                  </span>
                </div>
                <div className="text-sm text-gray-500">Actor: {event.actor}</div>
                <div className="text-xs text-gray-400 font-mono truncate mt-1">
                  Hash: {event.hash.substring(0, 16)}...
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export const Route = createFileRoute('/envelopes/$envelopeId')({
  component: EnvelopeDetailPage,
})
