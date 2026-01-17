/**
 * Library page - shows user's books with highlights
 * @module routes/library
 */
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { getLibrary, getHighlights, type Book, type Highlight } from '@/api/client'
import { useStore } from '@/stores/useStore'

export const Route = createFileRoute('/library')({
  component: LibraryPage,
})

function LibraryPage() {
  const navigate = useNavigate()
  const { isAuthenticated, library, setLibrary, highlights, setHighlights, searchQuery, setSearchQuery } = useStore()
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'books' | 'highlights'>('books')

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' })
      return
    }

    loadData()
  }, [isAuthenticated])

  const loadData = async () => {
    setLoading(true)
    try {
      const [libraryData, highlightsData] = await Promise.all([
        getLibrary(),
        getHighlights({ search: searchQuery || undefined }),
      ])
      setLibrary(libraryData)
      setHighlights(highlightsData)
    } catch (error) {
      console.error('Failed to load library:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    loadData()
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-500">Loading your library...</div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-900">My Library</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setView('books')}
            className={`rounded-md px-4 py-2 ${
              view === 'books'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700'
            }`}
          >
            Books
          </button>
          <button
            onClick={() => setView('highlights')}
            className={`rounded-md px-4 py-2 ${
              view === 'highlights'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700'
            }`}
          >
            All Highlights
          </button>
        </div>
      </div>

      <form onSubmit={handleSearch} className="mb-6">
        <div className="flex gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search your highlights..."
            className="flex-1 rounded-md border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            type="submit"
            className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          >
            Search
          </button>
        </div>
      </form>

      {view === 'books' ? (
        <BooksView books={library} />
      ) : (
        <HighlightsView highlights={highlights} />
      )}
    </div>
  )
}

interface BooksViewProps {
  books: Book[]
}

function BooksView({ books }: BooksViewProps) {
  if (books.length === 0) {
    return (
      <div className="rounded-lg bg-white p-8 text-center shadow-sm">
        <p className="text-gray-500">
          No books with highlights yet. Start reading and highlighting!
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {books.map((book) => (
        <Link
          key={book.id}
          to="/books/$bookId"
          params={{ bookId: book.id }}
          className="rounded-lg bg-white p-6 shadow-sm transition hover:shadow-md"
        >
          <h3 className="font-semibold text-gray-900">{book.title}</h3>
          <p className="text-sm text-gray-500">{book.author}</p>
          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="text-blue-600">{book.highlight_count} highlights</span>
            {book.last_highlighted && (
              <span className="text-gray-400">
                Last: {new Date(book.last_highlighted).toLocaleDateString()}
              </span>
            )}
          </div>
        </Link>
      ))}
    </div>
  )
}

interface HighlightsViewProps {
  highlights: Highlight[]
}

function HighlightsView({ highlights }: HighlightsViewProps) {
  if (highlights.length === 0) {
    return (
      <div className="rounded-lg bg-white p-8 text-center shadow-sm">
        <p className="text-gray-500">No highlights found.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {highlights.map((highlight) => (
        <HighlightCard key={highlight.id} highlight={highlight} />
      ))}
    </div>
  )
}

interface HighlightCardProps {
  highlight: Highlight
}

function HighlightCard({ highlight }: HighlightCardProps) {
  const colorClass = `highlight-${highlight.color}`

  return (
    <div className="rounded-lg bg-white p-6 shadow-sm">
      <div className="mb-2 flex items-start justify-between">
        <div>
          <span className="font-medium text-gray-900">{highlight.book_title}</span>
          <span className="ml-2 text-sm text-gray-500">by {highlight.book_author}</span>
        </div>
        <span className="text-xs text-gray-400">
          {new Date(highlight.created_at).toLocaleDateString()}
        </span>
      </div>
      <blockquote className={`rounded-md p-3 ${colorClass}`}>
        <p className="text-gray-800">"{highlight.highlighted_text}"</p>
      </blockquote>
      {highlight.note && (
        <p className="mt-3 text-sm italic text-gray-600">
          Note: {highlight.note}
        </p>
      )}
    </div>
  )
}
