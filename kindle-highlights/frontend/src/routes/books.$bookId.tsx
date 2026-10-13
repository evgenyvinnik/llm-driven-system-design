/**
 * Book detail page - shows highlights for a specific book
 * @module routes/books.$bookId
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getHighlights,
  getPopularHighlights,
  getFriendsHighlights,
  type Highlight,
  type PopularHighlight,
  type SyncOpResult,
} from '@/api/client'
import { useStore } from '@/stores/useStore'
import { enqueueDelete, enqueueUpdate, flushOutbox, withPending } from '@/sync/outbox'

export const Route = createFileRoute('/books/$bookId')({
  component: BookDetailPage,
})

type Tab = 'mine' | 'popular' | 'friends'

/** One line for the status region after the outbox was pushed. */
function describeFlush(results: SyncOpResult[]): string {
  if (results.some((r) => r.status === 'superseded')) return 'A newer edit from another device was kept.'
  if (results.some((r) => r.status === 'gone')) return 'That highlight was deleted on another device.'
  if (results.some((r) => r.status === 'rejected')) return 'A change was rejected and discarded.'
  return 'Saved.'
}

function BookDetailPage() {
  const { bookId } = Route.useParams()
  const navigate = useNavigate()
  const { isAuthenticated, removeHighlight } = useStore()
  const remoteSeq = useStore((state) => state.remoteSeq)
  const pendingOps = useStore((state) => state.pendingOps)
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [popularHighlights, setPopularHighlights] = useState<PopularHighlight[]>([])
  const [friendsHighlights, setFriendsHighlights] = useState<Highlight[]>([])
  const [errors, setErrors] = useState<Partial<Record<Tab, string>>>({})
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<Tab>('mine')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editNote, setEditNote] = useState('')
  const [status, setStatus] = useState('')

  /** Loads the three panels independently: one failing service doesn't blank the page. */
  const loadData = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true)
      const [mine, popular, friends] = await Promise.allSettled([
        getHighlights({ bookId }),
        getPopularHighlights(bookId),
        getFriendsHighlights(bookId),
      ])
      const failed: Partial<Record<Tab, string>> = {}
      if (mine.status === 'fulfilled') setHighlights(mine.value)
      else failed.mine = 'Your highlights could not be loaded.'
      if (popular.status === 'fulfilled') setPopularHighlights(popular.value)
      else failed.popular = 'Popular highlights are unavailable right now.'
      if (friends.status === 'fulfilled') setFriendsHighlights(friends.value)
      else failed.friends = "Friends' highlights are unavailable right now."
      setErrors(failed)
      setLoading(false)
    },
    [bookId]
  )

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' })
      return
    }
    loadData()
  }, [isAuthenticated, bookId, navigate, loadData])

  // Another device wrote: refresh in the background (the socket only says "something changed").
  const firstRemoteSeq = useRef(remoteSeq)
  useEffect(() => {
    if (remoteSeq !== firstRemoteSeq.current) loadData(true)
  }, [remoteSeq, loadData])

  /** Pushes the outbox and reconciles with what the server decided. */
  const sync = async () => {
    try {
      const results = await flushOutbox()
      setStatus(describeFlush(results))
      await loadData(true)
    } catch {
      setStatus("Saved on this device. It will sync when you're back online.")
    }
  }

  const handleDelete = (id: string) => {
    if (!confirm('Delete this highlight?')) return
    enqueueDelete(id)
    setHighlights((prev) => prev.filter((h) => h.id !== id))
    removeHighlight(id)
    void sync()
  }

  const handleUpdateNote = (id: string) => {
    const note = editNote.trim() === '' ? null : editNote
    enqueueUpdate(id, { note })
    setHighlights((prev) => prev.map((h) => (h.id === id ? { ...h, note } : h)))
    setEditingId(null)
    setEditNote('')
    void sync()
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-500">Loading book...</div>
      </div>
    )
  }

  // Queued edits stay visible even if a refetch lands before they reach the server.
  const myHighlights = pendingOps > 0 ? withPending(highlights) : highlights
  const bookTitle = myHighlights[0]?.book_title || 'Book'
  const bookAuthor = myHighlights[0]?.book_author || ''

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">{bookTitle}</h1>
        {bookAuthor && <p className="text-lg text-gray-500">by {bookAuthor}</p>}
      </div>

      <p role="status" aria-live="polite" className="mb-4 min-h-5 text-sm text-gray-600">
        {status}
      </p>

      <div role="tablist" aria-label="Highlights" className="mb-6 flex gap-2">
        <TabButton
          id="mine"
          active={activeTab === 'mine'}
          onClick={() => setActiveTab('mine')}
          count={myHighlights.length}
        >
          My Highlights
        </TabButton>
        <TabButton
          id="popular"
          active={activeTab === 'popular'}
          onClick={() => setActiveTab('popular')}
          count={popularHighlights.length}
        >
          Popular
        </TabButton>
        <TabButton
          id="friends"
          active={activeTab === 'friends'}
          onClick={() => setActiveTab('friends')}
          count={friendsHighlights.length}
        >
          Friends
        </TabButton>
      </div>

      {activeTab === 'mine' && (
        <div role="tabpanel" id="panel-mine" aria-labelledby="tab-mine" className="space-y-4">
          {errors.mine ? (
            <EmptyState message={errors.mine} />
          ) : myHighlights.length === 0 ? (
            <EmptyState message="No highlights yet. Start highlighting!" />
          ) : (
            myHighlights.map((h) => (
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
        <div role="tabpanel" id="panel-popular" aria-labelledby="tab-popular" className="space-y-4">
          {errors.popular ? (
            <EmptyState message={errors.popular} />
          ) : popularHighlights.length === 0 ? (
            <EmptyState message="No popular highlights yet. A passage appears once enough readers have highlighted it." />
          ) : (
            popularHighlights.map((h) => (
              <PopularHighlightCard key={h.passage_id} highlight={h} />
            ))
          )}
        </div>
      )}

      {activeTab === 'friends' && (
        <div role="tabpanel" id="panel-friends" aria-labelledby="tab-friends" className="space-y-4">
          {errors.friends ? (
            <EmptyState message={errors.friends} />
          ) : friendsHighlights.length === 0 ? (
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
  id: Tab
  active: boolean
  onClick: () => void
  count: number
  children: React.ReactNode
}

function TabButton({ id, active, onClick, count, children }: TabButtonProps) {
  return (
    <button
      id={`tab-${id}`}
      role="tab"
      aria-selected={active}
      aria-controls={`panel-${id}`}
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
            aria-label="Note"
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
        {highlight.reader_count} readers highlighted this passage
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
