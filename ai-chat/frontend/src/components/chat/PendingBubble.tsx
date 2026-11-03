import { AlertIcon, SpinnerIcon } from '@/components/icons'
import { discardPending, retryPending } from '@/services/chat-actions'
import type { PendingSend } from '@/stores/conversations-store'

/** A sent message the server hasn't acknowledged yet, or one that failed to send. */
export function PendingBubble({ pending }: { pending: PendingSend }) {
  return (
    <div className="flex flex-col items-end">
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[15px] leading-7 ${
          pending.status === 'failed' ? 'border border-red-200 bg-red-50 text-slate-800' : 'bg-slate-100 text-slate-600'
        }`}
      >
        {pending.content}
      </div>
      {pending.status === 'sending' ? (
        <span className="mt-1 inline-flex items-center gap-1 text-xs text-slate-400">
          <SpinnerIcon className="h-3 w-3" /> Sending…
        </span>
      ) : (
        <div className="mt-1 flex items-center gap-2 text-xs text-red-700" role="alert">
          <AlertIcon className="h-3.5 w-3.5" />
          <span>{pending.error}</span>
          <button type="button" className="font-medium underline" onClick={() => void retryPending(pending.key)}>
            Retry
          </button>
          <button type="button" className="text-slate-500 underline" onClick={() => discardPending(pending.key)}>
            Discard
          </button>
        </div>
      )}
    </div>
  )
}
