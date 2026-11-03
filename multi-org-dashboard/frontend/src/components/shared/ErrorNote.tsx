import { AlertIcon } from '@/components/icons'
import { ApiError } from '@/services/api'

/**
 * Inline error for a panel. 403s are rendered by the access components, and
 * 401 sends the user to sign in, so this mostly shows 404s and failures.
 */
export function ErrorNote({ error, notFound }: { error: unknown; notFound?: string }) {
  let message = 'Something went wrong. Try again.'
  if (error instanceof ApiError) {
    if (error.status === 404) message = notFound ?? "This doesn't exist, or you don't have access to it."
    else if (error.status === 403) message = error.message
    else if (error.status === 0) message = error.message
    else if (error.status < 500) message = error.message
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="alert">
      <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  )
}
