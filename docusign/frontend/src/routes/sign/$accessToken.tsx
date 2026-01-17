import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState, useRef, useCallback } from 'react'
import { signingApi } from '../../services/api'
import { SigningSession, DocumentField } from '../../types'
import { Document, Page, pdfjs } from 'react-pdf'
import SignaturePad from 'signature_pad'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

// Set up PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`

function SigningPage() {
  const { accessToken } = Route.useParams()
  const navigate = useNavigate()

  const [session, setSession] = useState<SigningSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // Document viewing state
  const [selectedDocIndex, setSelectedDocIndex] = useState(0)
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)

  // Signature modal state
  const [showSignatureModal, setShowSignatureModal] = useState(false)
  const [activeField, setActiveField] = useState<DocumentField | null>(null)
  const [signatureType, setSignatureType] = useState<'draw' | 'typed'>('draw')
  const [typedSignature, setTypedSignature] = useState('')
  const signaturePadRef = useRef<SignaturePad | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Completed fields tracking
  const [completedFields, setCompletedFields] = useState<Set<string>>(new Set())

  useEffect(() => {
    loadSession()
  }, [accessToken])

  async function loadSession() {
    try {
      setLoading(true)
      const data = await signingApi.getSession(accessToken)
      setSession(data)

      // Track already completed fields
      const completed = new Set<string>()
      data.fields.forEach((f: DocumentField) => {
        if (f.completed) completed.add(f.id)
      })
      setCompletedFields(completed)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (showSignatureModal && canvasRef.current && signatureType === 'draw') {
      signaturePadRef.current = new SignaturePad(canvasRef.current, {
        backgroundColor: 'rgb(255, 255, 255)',
        penColor: 'rgb(0, 0, 0)',
      })
    }

    return () => {
      if (signaturePadRef.current) {
        signaturePadRef.current.off()
      }
    }
  }, [showSignatureModal, signatureType])

  function openSignatureModal(field: DocumentField) {
    setActiveField(field)
    setShowSignatureModal(true)
    setTypedSignature('')
  }

  function closeSignatureModal() {
    setShowSignatureModal(false)
    setActiveField(null)
    if (signaturePadRef.current) {
      signaturePadRef.current.clear()
    }
  }

  async function handleSign() {
    if (!activeField) return

    let signatureData: string

    if (signatureType === 'draw') {
      if (!signaturePadRef.current || signaturePadRef.current.isEmpty()) {
        setError('Please draw your signature')
        return
      }
      signatureData = signaturePadRef.current.toDataURL('image/png')
    } else {
      if (!typedSignature.trim()) {
        setError('Please type your signature')
        return
      }
      // Create a canvas with typed signature
      const canvas = document.createElement('canvas')
      canvas.width = 400
      canvas.height = 100
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = 'white'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = 'black'
      ctx.font = 'italic 36px "Brush Script MT", cursive'
      ctx.fillText(typedSignature, 20, 60)
      signatureData = canvas.toDataURL('image/png')
    }

    setError('')
    try {
      await signingApi.sign(accessToken, activeField.id, signatureData, signatureType)
      setCompletedFields((prev) => new Set(prev).add(activeField.id))
      setSuccess('Signature captured!')
      setTimeout(() => setSuccess(''), 3000)
      closeSignatureModal()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function handleCompleteField(field: DocumentField, value?: string) {
    setError('')
    try {
      await signingApi.completeField(accessToken, field.id, value)
      setCompletedFields((prev) => new Set(prev).add(field.id))
      setSuccess('Field completed!')
      setTimeout(() => setSuccess(''), 3000)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function handleFinish() {
    const incompleteCount = session!.fields.filter(
      (f) => f.required && !completedFields.has(f.id)
    ).length

    if (incompleteCount > 0) {
      setError(`Please complete all ${incompleteCount} required fields before finishing.`)
      return
    }

    if (!confirm('Are you sure you want to finish signing?')) return

    setError('')
    try {
      await signingApi.finish(accessToken)
      setSuccess('Signing completed successfully!')
      setTimeout(() => {
        navigate({ to: '/signing-complete' })
      }, 2000)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function handleDecline() {
    const reason = prompt('Please provide a reason for declining (optional):')
    if (reason === null) return // User cancelled

    try {
      await signingApi.decline(accessToken, reason)
      setSuccess('Document declined.')
      setTimeout(() => {
        navigate({ to: '/signing-declined' })
      }, 2000)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-gray-300 border-t-docusign-blue rounded-full spinner mx-auto mb-4" />
          <p className="text-gray-600">Loading document...</p>
        </div>
      </div>
    )
  }

  if (error && !session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="bg-white p-8 rounded-lg shadow-lg text-center max-w-md">
          <svg className="w-16 h-16 text-red-500 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <h1 className="text-xl font-bold text-gray-900 mb-2">Unable to Load Document</h1>
          <p className="text-gray-600">{error}</p>
        </div>
      </div>
    )
  }

  if (!session) return null

  const currentDoc = session.documents[selectedDocIndex]
  const currentPageFields = session.fields.filter(
    (f) => f.document_id === currentDoc?.id && f.page_number === currentPage
  )
  const completedCount = completedFields.size
  const totalRequiredCount = session.fields.filter((f) => f.required).length

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-xl font-bold text-gray-900">{session.envelope.name}</h1>
              <p className="text-sm text-gray-500">
                Please review and sign - {session.recipient.name}
              </p>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-600">
                {completedCount}/{totalRequiredCount} fields completed
              </span>
              <button
                onClick={handleDecline}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Decline
              </button>
              <button
                onClick={handleFinish}
                className="px-4 py-2 bg-docusign-blue text-white rounded-lg font-medium hover:bg-docusign-dark"
              >
                Finish
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Messages */}
      {error && (
        <div className="max-w-7xl mx-auto px-4 mt-4">
          <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm">{error}</div>
        </div>
      )}
      {success && (
        <div className="max-w-7xl mx-auto px-4 mt-4">
          <div className="bg-green-50 text-green-600 p-3 rounded-lg text-sm">{success}</div>
        </div>
      )}

      {/* Envelope message */}
      {session.envelope.message && (
        <div className="max-w-7xl mx-auto px-4 mt-4">
          <div className="bg-blue-50 p-4 rounded-lg">
            <p className="text-sm text-blue-800">{session.envelope.message}</p>
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-4 gap-6">
          {/* Sidebar */}
          <div className="col-span-1 space-y-4">
            {/* Document selector */}
            {session.documents.length > 1 && (
              <div className="bg-white rounded-lg shadow p-4">
                <h3 className="font-medium mb-2">Documents</h3>
                <select
                  value={selectedDocIndex}
                  onChange={(e) => {
                    setSelectedDocIndex(Number(e.target.value))
                    setCurrentPage(1)
                  }}
                  className="w-full px-3 py-2 border rounded-lg"
                >
                  {session.documents.map((doc, i) => (
                    <option key={doc.id} value={i}>
                      {doc.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Page navigation */}
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="font-medium mb-2">Page {currentPage} of {numPages || '?'}</h3>
              <div className="flex space-x-2">
                <button
                  onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage <= 1}
                  className="flex-1 px-3 py-2 border rounded-lg disabled:opacity-50"
                >
                  Prev
                </button>
                <button
                  onClick={() => setCurrentPage(Math.min(numPages, currentPage + 1))}
                  disabled={currentPage >= numPages}
                  className="flex-1 px-3 py-2 border rounded-lg disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>

            {/* Fields to complete */}
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="font-medium mb-2">Fields to Sign</h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {session.fields.map((field) => {
                  const isCompleted = completedFields.has(field.id)
                  const doc = session.documents.find((d) => d.id === field.document_id)
                  return (
                    <button
                      key={field.id}
                      onClick={() => {
                        const docIndex = session.documents.findIndex((d) => d.id === field.document_id)
                        setSelectedDocIndex(docIndex)
                        setCurrentPage(field.page_number)
                      }}
                      className={`w-full text-left p-2 rounded text-sm ${
                        isCompleted ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'
                      }`}
                    >
                      <div className="flex justify-between items-center">
                        <span className="capitalize font-medium">{field.type}</span>
                        {isCompleted ? (
                          <svg className="w-4 h-4 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        ) : (
                          <span className="text-xs">Page {field.page_number}</span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {/* PDF viewer */}
          <div className="col-span-3 bg-white rounded-lg shadow p-4">
            <div className="relative border rounded-lg overflow-hidden bg-gray-100">
              <Document
                file={signingApi.getDocument(accessToken, currentDoc.id)}
                onLoadSuccess={({ numPages }) => setNumPages(numPages)}
                loading={
                  <div className="flex items-center justify-center h-96">
                    <div className="w-8 h-8 border-4 border-gray-300 border-t-docusign-blue rounded-full spinner" />
                  </div>
                }
              >
                <Page pageNumber={currentPage} width={700} />
              </Document>

              {/* Field overlays */}
              {currentPageFields.map((field) => {
                const isCompleted = completedFields.has(field.id)
                return (
                  <div
                    key={field.id}
                    className={`field-highlight ${field.type} ${isCompleted ? 'completed' : ''}`}
                    style={{
                      left: field.x,
                      top: field.y,
                      width: field.width,
                      height: field.height,
                    }}
                    onClick={() => {
                      if (isCompleted) return
                      if (['signature', 'initial'].includes(field.type)) {
                        openSignatureModal(field)
                      } else if (field.type === 'date') {
                        handleCompleteField(field, new Date().toISOString().split('T')[0])
                      } else if (field.type === 'checkbox') {
                        handleCompleteField(field, 'checked')
                      } else {
                        const value = prompt('Enter text:')
                        if (value) handleCompleteField(field, value)
                      }
                    }}
                  >
                    {isCompleted ? (
                      <span className="absolute inset-0 flex items-center justify-center text-green-600">
                        <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      </span>
                    ) : (
                      <span className="absolute inset-0 flex items-center justify-center text-xs font-medium opacity-70">
                        {field.type === 'signature' ? 'Sign here' : field.type === 'initial' ? 'Initial' : field.type}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Signature Modal */}
      {showSignatureModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-lg">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold">
                {activeField?.type === 'initial' ? 'Add Your Initials' : 'Add Your Signature'}
              </h2>
              <button onClick={closeSignatureModal} className="text-gray-500 hover:text-gray-700">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Signature type tabs */}
            <div className="flex border-b mb-4">
              <button
                onClick={() => setSignatureType('draw')}
                className={`flex-1 py-2 text-center font-medium ${
                  signatureType === 'draw'
                    ? 'border-b-2 border-docusign-blue text-docusign-blue'
                    : 'text-gray-500'
                }`}
              >
                Draw
              </button>
              <button
                onClick={() => setSignatureType('typed')}
                className={`flex-1 py-2 text-center font-medium ${
                  signatureType === 'typed'
                    ? 'border-b-2 border-docusign-blue text-docusign-blue'
                    : 'text-gray-500'
                }`}
              >
                Type
              </button>
            </div>

            {signatureType === 'draw' ? (
              <div className="signature-pad-container">
                <canvas
                  ref={canvasRef}
                  width={450}
                  height={150}
                  className="w-full rounded-lg"
                />
                <button
                  onClick={() => signaturePadRef.current?.clear()}
                  className="absolute top-2 right-2 text-sm text-gray-500 hover:text-gray-700"
                >
                  Clear
                </button>
              </div>
            ) : (
              <div>
                <input
                  type="text"
                  value={typedSignature}
                  onChange={(e) => setTypedSignature(e.target.value)}
                  placeholder="Type your name"
                  className="w-full px-4 py-3 border rounded-lg text-2xl italic font-serif"
                />
                {typedSignature && (
                  <div className="mt-4 p-4 bg-gray-50 rounded-lg">
                    <p className="text-sm text-gray-500 mb-2">Preview:</p>
                    <p className="text-3xl italic font-serif">{typedSignature}</p>
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end space-x-3 mt-6">
              <button
                onClick={closeSignatureModal}
                className="px-4 py-2 border rounded-lg text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSign}
                className="px-4 py-2 bg-docusign-blue text-white rounded-lg font-medium hover:bg-docusign-dark"
              >
                Apply Signature
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export const Route = createFileRoute('/sign/$accessToken')({
  component: SigningPage,
})
