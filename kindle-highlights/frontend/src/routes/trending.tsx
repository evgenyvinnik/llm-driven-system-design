/**
 * Trending highlights page
 * @module routes/trending
 */
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { getTrending, type PopularHighlight } from '@/api/client'

export const Route = createFileRoute('/trending')({
  component: TrendingPage,
})

function TrendingPage() {
  const [highlights, setHighlights] = useState<PopularHighlight[]>([])
  const [loading, setLoading] = useState(true)
  const [days, setDays] = useState(7)

  useEffect(() => {
    loadTrending()
  }, [days])

  const loadTrending = async () => {
    setLoading(true)
    try {
      const data = await getTrending({ limit: 20, days })
      setHighlights(data)
    } catch (error) {
      console.error('Failed to load trending:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-900">Trending Highlights</h1>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
        >
          <option value={1}>Last 24 hours</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
        </select>
      </div>

      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <div className="text-gray-500">Loading trending highlights...</div>
        </div>
      ) : highlights.length === 0 ? (
        <div className="rounded-lg bg-white p-8 text-center shadow-sm">
          <p className="text-gray-500">No trending highlights found.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {highlights.map((highlight, index) => (
            <TrendingCard
              key={highlight.passage_id}
              highlight={highlight}
              rank={index + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface TrendingCardProps {
  highlight: PopularHighlight
  rank: number
}

function TrendingCard({ highlight, rank }: TrendingCardProps) {
  return (
    <div className="rounded-lg bg-white p-6 shadow-sm">
      <div className="mb-3 flex items-start gap-4">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-sm font-bold text-blue-600">
          {rank}
        </div>
        <div>
          <h3 className="font-semibold text-gray-900">{highlight.book_title}</h3>
          <p className="text-sm text-gray-500">by {highlight.book_author}</p>
        </div>
      </div>
      <blockquote className="rounded-md bg-kindle-yellow/40 p-4">
        <p className="text-lg text-gray-800">"{highlight.passage_text}"</p>
      </blockquote>
      <p className="mt-3 text-sm text-gray-500">
        {highlight.highlight_count} readers highlighted this
      </p>
    </div>
  )
}
