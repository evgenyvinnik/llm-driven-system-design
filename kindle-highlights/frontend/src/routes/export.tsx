/**
 * Export highlights page
 * @module routes/export
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { exportHighlights } from '@/api/client'
import { useStore } from '@/stores/useStore'

export const Route = createFileRoute('/export')({
  component: ExportPage,
})

function ExportPage() {
  const navigate = useNavigate()
  const { isAuthenticated } = useStore()
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [format, setFormat] = useState<'markdown' | 'csv' | 'json'>('markdown')

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' })
    }
  }, [isAuthenticated])

  const handlePreview = async () => {
    setLoading(true)
    try {
      const data = await exportHighlights(format)
      setPreview(data)
    } catch (error) {
      console.error('Failed to export:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleDownload = async () => {
    setLoading(true)
    try {
      const data = await exportHighlights(format)
      const blob = new Blob([data], { type: getContentType(format) })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `my-highlights.${format === 'markdown' ? 'md' : format}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Failed to download:', error)
    } finally {
      setLoading(false)
    }
  }

  const getContentType = (fmt: string) => {
    switch (fmt) {
      case 'markdown':
        return 'text/markdown'
      case 'csv':
        return 'text/csv'
      case 'json':
        return 'application/json'
      default:
        return 'text/plain'
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-8 text-3xl font-bold text-gray-900">Export Highlights</h1>

      <div className="rounded-lg bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">
          Choose Export Format
        </h2>

        <div className="mb-6 grid gap-4 md:grid-cols-3">
          <FormatOption
            format="markdown"
            selected={format === 'markdown'}
            onSelect={() => setFormat('markdown')}
            title="Markdown"
            description="Best for note-taking apps like Notion, Obsidian"
          />
          <FormatOption
            format="csv"
            selected={format === 'csv'}
            onSelect={() => setFormat('csv')}
            title="CSV"
            description="Best for spreadsheets like Excel, Google Sheets"
          />
          <FormatOption
            format="json"
            selected={format === 'json'}
            onSelect={() => setFormat('json')}
            title="JSON"
            description="Best for developers and data processing"
          />
        </div>

        <div className="flex gap-4">
          <button
            onClick={handlePreview}
            disabled={loading}
            className="rounded-md bg-gray-100 px-4 py-2 text-gray-700 hover:bg-gray-200 disabled:opacity-50"
          >
            {loading ? 'Loading...' : 'Preview'}
          </button>
          <button
            onClick={handleDownload}
            disabled={loading}
            className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Downloading...' : 'Download'}
          </button>
        </div>
      </div>

      {preview && (
        <div className="mt-6 rounded-lg bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Preview</h3>
          <pre className="max-h-96 overflow-auto rounded-md bg-gray-50 p-4 text-sm">
            {preview}
          </pre>
        </div>
      )}
    </div>
  )
}

interface FormatOptionProps {
  format: string
  selected: boolean
  onSelect: () => void
  title: string
  description: string
}

function FormatOption({
  selected,
  onSelect,
  title,
  description,
}: FormatOptionProps) {
  return (
    <button
      onClick={onSelect}
      className={`rounded-lg border-2 p-4 text-left transition ${
        selected
          ? 'border-blue-600 bg-blue-50'
          : 'border-gray-200 hover:border-gray-300'
      }`}
    >
      <h4 className="font-medium text-gray-900">{title}</h4>
      <p className="mt-1 text-sm text-gray-500">{description}</p>
    </button>
  )
}
