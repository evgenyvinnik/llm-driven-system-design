/**
 * Book detail page - shows highlights for a specific book
 * @module routes/books.$bookId
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  getHighlights,
  getPopularHighlights,
  getFriendsHighlights,
  deleteHighlight,
  updateHighlight,
  type Highlight,
  type PopularHighlight,
} from '@/api/client'
import { useStore } from '@/stores/useStore'

export const Route = createFileRoute('/books/$bookId')({
  component: BookDetailPage,
})

function BookDetailPage() {
  const { bookId } = Route.useParams()
  const navigate = useNavigate()
  const { isAuthenticated, removeHighlight } = useStore()
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [popularHighlights, setPopularHighlights] = useState<PopularHighlight[]>([])
  const [friendsHighlights, setFriendsHighlights] = useState<Highlight[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'mine' | 'popular' | 'friends'>('mine')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editNote, setEditNote] = useState('')

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' })
      return
    }
    loadData()
  }, [isAuthenticated, bookId])

  const loadData = async () => {
    setLoading(true)
    try {
      const [myHighlights, popular, friends] = await Promise.all([
        getHighlights({ bookId }),
        getPopularHighlights(bookId),
        getFriendsHighlights(bookId),
      ])
      setHighlights(myHighlights)
      setPopularHighlights(popular)
      setFriendsHighlights(friends)
    } catch (error) {
      console.error('Failed to load book data:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this highlight?')) return
    try {
      await deleteHighlight(id)
      setHighlights((prev) => prev.filter((h) => h.id !== id))
      removeHighlight(id)
    } catch (error) {
      console.error('Failed to delete highlight:', error)
    }
  }

  const handleUpdateNote = async (id: string) => {
    try {
      await updateHighlight(id, { note: editNote })
      setHighlights((prev) =>
        prev.map((h) => (h.id === id ? { ...h, note: editNote } : h))
      )
      setEditingId(null)
      setEditNote('')
    } catch (error) {
      console.error('Failed to update highlight:', error)
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-500">Loading book...</div>
      </div>
    )
  }

  const bookTitle = highlights[0]?.book_title || 'Book'
  const bookAuthor = highlights[0]?.book_author || ''

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">{bookTitle}</h1>
        {bookAuthor && <p className="text-lg text-gray-500">by {bookAuthor}</p>}
      </div>

      <div className="mb-6 flex gap-2">
        <TabButton
          active={activeTab === 'mine'}
          onClick={() => setActiveTab('mine')}
          count={highlights.length}
        >
          My Highlights
        </TabButton>
        <TabButton
          active={activeTab === 'popular'}
          onClick={() => setActiveTab('popular')}
          count={popularHighlights.length}
        >
          Popular
        </TabButton>
        <TabButton
          active={activeTab === 'friends'}
          onClick={() => setActiveTab('friends')}
          count={friendsHighlights.length}
        >
          Friends
        </TabButton>
      </div>

      {activeTab === 'mine' && (
        <div className="space-y-4">
          {highlights.length === 0 ? (
            <EmptyState message="No highlights yet. Start highlighting!" />
          ) : (
            highlights.map((h) => (
              <MyHighlightCard
                key={h.id}
                highlight={h}
                isEditing={editingId === h.id}
                editNote={editNote}
                onEditStart={() => {
                  setEditingId(h.id)
                  setEditNote(h.note || '')
                }}
                onEditCancel={() => setEditingId(null)}
                onEditSave={() => handleUpdateNote(h.id)}
                onNoteChange={setEditNote}
                onDelete={() => handleDelete(h.id)}
              />
            ))
          )}
        </div>
      )}

      {activeTab === 'popular' && (
        <div className="space-y-4">
          {popularHighlights.length === 0 ? (
            <EmptyState message="No popular highlights for this book yet." />
          ) : (
            popularHighlights.map((h) => (
              <PopularHighlightCard key={h.passage_id} highlight={h} />
            ))
          )}
        </div>
      )}

      {activeTab === 'friends' && (
        <div className="space-y-4">
          {friendsHighlights.length === 0 ? (
            <EmptyState message="No highlights from friends for this book." />
          ) : (
            friendsHighlights.map((h) => (
              <FriendHighlightCard key={h.id} highlight={h} />
            ))
          )}
        </div>
      )}
    </div>
  )
}

interface TabButtonProps {
  active: boolean
  onClick: () => void
  count: number
  children: React.ReactNode
}

function TabButton({ active, onClick, count, children }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-4 py-2 ${
        active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'
      }`}
    >
      {children} ({count})
    </button>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg bg-white p-8 text-center shadow-sm">
      <p className="text-gray-500">{message}</p>
    </div>
  )
}

interface MyHighlightCardProps {
  highlight: Highlight
  isEditing: boolean
  editNote: string
  onEditStart: () => void
  onEditCancel: () => void
  onEditSave: () => void
  onNoteChange: (note: string) => void
  onDelete: () => void
}

function MyHighlightCard({
  highlight,
  isEditing,
  editNote,
  onEditStart,
  onEditCancel,
  onEditSave,
  onNoteChange,
  onDelete,
}: MyHighlightCardProps) {
  const colorClass = `highlight-${highlight.color}`

  return (
    <div className="rounded-lg bg-white p-6 shadow-sm">
      <blockquote className={`rounded-md p-3 ${colorClass}`}>
        <p className="text-gray-800">"{highlight.highlighted_text}"</p>
      </blockquote>

      {isEditing ? (
        <div className="mt-4">
          <textarea
            value={editNote}
            onChange={(e) => onNoteChange(e.target.value)}
            placeholder="Add a note..."
            className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
            rows={2}
          />
          <div className="mt-2 flex gap-2">
            <button
              onClick={onEditSave}
              className="rounded-md bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700"
            >
              Save
            </button>
            <button
              onClick={onEditCancel}
              className="rounded-md bg-gray-100 px-3 py-1 text-sm text-gray-700 hover:bg-gray-200"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {highlight.note && (
            <p className="mt-3 text-sm italic text-gray-600">
              Note: {highlight.note}
            </p>
          )}
          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="text-gray-400">
              {new Date(highlight.created_at).toLocaleDateString()}
            </span>
            <div className="flex gap-2">
              <button
                onClick={onEditStart}
                className="text-gray-500 hover:text-gray-700"
              >
                Edit
              </button>
              <button
                onClick={onDelete}
                className="text-red-500 hover:text-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

interface PopularHighlightCardProps {
  highlight: PopularHighlight
}

function PopularHighlightCard({ highlight }: PopularHighlightCardProps) {
  return (
    <div className="rounded-lg bg-white p-6 shadow-sm">
      <blockquote className="rounded-md bg-kindle-yellow/40 p-3">
        <p className="text-gray-800">"{highlight.passage_text}"</p>
      </blockquote>
      <p className="mt-3 text-sm text-gray-500">
        {highlight.highlight_count} readers highlighted this passage
      </p>
    </div>
  )
}

interface FriendHighlightCardProps {
  highlight: Highlight & { username?: string; avatar_url?: string }
}

function FriendHighlightCard({ highlight }: FriendHighlightCardProps) {
  return (
    <div className="rounded-lg bg-white p-6 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-sm">
          {highlight.username?.[0]?.toUpperCase() || '?'}
        </div>
        <span className="font-medium text-gray-900">{highlight.username}</span>
      </div>
      <blockquote className={`rounded-md bg-kindle-${highlight.color}/40 p-3`}>
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
