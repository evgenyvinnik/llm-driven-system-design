import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { LinkIcon } from '@/components/icons'
import { Loading } from '@/components/shared'
import { dateTime } from '@/lib/format'
import { api, ApiError } from '@/services/api'

export const Route = createFileRoute('/share/$token')({ component: SharedPromptPage })

/** Public, read-only view of a prompt shared by link. No session needed; nothing cached. */
function SharedPromptPage() {
  const { token } = Route.useParams()
  const { data, error, isPending } = useQuery({
    queryKey: ['shared', token],
    queryFn: () => api.shared(token),
    retry: false,
    gcTime: 0,
  })
  if (isPending) return <Loading />
  if (error || !data) {
    const gone = error instanceof ApiError && error.status === 410
    return (
      <main className="mx-auto max-w-lg px-4 py-24 text-center" data-testid="share-unavailable">
        <h1 className="text-lg font-semibold">{gone ? error.message : 'This link does not exist'}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {gone ? 'Ask the person who shared it for a new link.' : 'Check that you copied the whole link.'}
        </p>
      </main>
    )
  }
  const { prompt } = data
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
        <LinkIcon className="h-3.5 w-3.5" /> Shared prompt · {prompt.orgName}
      </p>
      <h1 className="mt-2 text-2xl font-semibold">{prompt.title}</h1>
      <p className="mt-1 text-sm text-slate-500">
        By {prompt.ownerName ?? 'a former member'} · updated {dateTime(prompt.updatedAt)}
        {prompt.expiresAt && ` · link expires ${dateTime(prompt.expiresAt)}`}
      </p>
      <pre className="card mt-6 whitespace-pre-wrap p-4 font-mono text-sm text-slate-800">{prompt.body}</pre>
    </main>
  )
}
