/**
 * Drag-and-drop upload. Each file gets its own Idempotency-Key when it is
 * picked; "Retry upload" resends with the same key, so a retry after a lost
 * response can never create a second document. The server answers a known
 * content hash with the existing document (duplicate notice).
 */
import { Link } from '@tanstack/react-router'
import { useRef, useState, type DragEvent } from 'react'
import { CheckIcon, ReplayIcon, SpinnerIcon, UploadIcon, XIcon } from '@/components/icons'
import { ApiError, api } from '@/services/api'
import type { DocumentItem } from '@/types'

const ACCEPT = '.txt,.md,.markdown,.html,.htm'

interface Item {
  id: string
  file: File
  key: string
  state: 'uploading' | 'created' | 'duplicate' | 'error'
  message: string | null
  document: DocumentItem | null
}

export function UploadZone({ onUploaded }: { onUploaded: () => void }) {
  const [items, setItems] = useState<Item[]>([])
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const patch = (id: string, p: Partial<Item>) => setItems((list) => list.map((i) => (i.id === id ? { ...i, ...p } : i)))

  async function send(item: Item) {
    patch(item.id, { state: 'uploading', message: null })
    try {
      const res = await api.upload(item.file, item.key)
      patch(item.id, { state: res.duplicate ? 'duplicate' : 'created', document: res.document })
      onUploaded()
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Upload failed'
      patch(item.id, { state: 'error', message })
    }
  }

  function add(files: FileList | File[]) {
    const next = [...files].map((file) => ({ id: crypto.randomUUID(), file, key: crypto.randomUUID(), state: 'uploading' as const, message: null, document: null }))
    setItems((list) => [...next, ...list].slice(0, 8))
    next.forEach((i) => void send(i))
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setOver(false)
    if (e.dataTransfer.files.length > 0) add(e.dataTransfer.files)
  }

  return (
    <section aria-label="Upload" className="space-y-2">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`flex items-center justify-between gap-4 rounded-lg border-2 border-dashed px-5 py-4 ${over ? 'border-accent-500 bg-accent-50' : 'border-slate-300 bg-white'}`}
      >
        <div className="flex items-center gap-3">
          <UploadIcon className="h-6 w-6 text-slate-400" />
          <div>
            <div className="text-sm font-medium text-slate-800">Drop files to upload</div>
            <div className="text-xs text-slate-500">.txt, .md and .html, up to 5 MB. New documents start private to you.</div>
          </div>
        </div>
        <button type="button" className="btn-secondary" onClick={() => input.current?.click()}>
          Choose files
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          aria-label="Choose files to upload"
          onChange={(e) => {
            if (e.target.files) add(e.target.files)
            e.target.value = ''
          }}
        />
      </div>
      {items.length > 0 && (
        <ul className="space-y-1" aria-label="Uploads">
          {items.map((i) => (
            <UploadRow key={i.id} item={i} onRetry={() => void send(i)} onDismiss={() => setItems((l) => l.filter((x) => x.id !== i.id))} />
          ))}
        </ul>
      )}
    </section>
  )
}

function UploadRow({ item, onRetry, onDismiss }: { item: Item; onRetry: () => void; onDismiss: () => void }) {
  const tone =
    item.state === 'error' ? 'border-rose-200 bg-rose-50' : item.state === 'duplicate' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'
  return (
    <li className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${tone}`}>
      {item.state === 'uploading' && <SpinnerIcon className="h-4 w-4 text-slate-400" />}
      {item.state === 'created' && <CheckIcon className="h-4 w-4 text-emerald-600" />}
      <span className="font-medium text-slate-800">{item.file.name}</span>
      <span className="flex-1 text-slate-600">
        {item.state === 'uploading' && 'Uploading…'}
        {item.state === 'created' && 'Uploaded; processing started.'}
        {item.state === 'duplicate' && item.document && (
          <>
            Already in your library:{' '}
            <Link to="/documents/$documentId" params={{ documentId: item.document.id }} search={{}} className="font-medium text-accent-700 hover:underline">
              {item.document.title}
            </Link>{' '}
            (same content, nothing new created)
          </>
        )}
        {item.state === 'error' && <span className="text-rose-800">{item.message}</span>}
      </span>
      {item.state === 'error' && (
        <button type="button" className="btn-ghost" onClick={onRetry} title="Resend with the same Idempotency-Key">
          <ReplayIcon className="h-3.5 w-3.5" /> Retry upload
        </button>
      )}
      <button type="button" className="rounded p-1 text-slate-400 hover:text-slate-700" onClick={onDismiss} aria-label="Dismiss">
        <XIcon className="h-3.5 w-3.5" />
      </button>
    </li>
  )
}
