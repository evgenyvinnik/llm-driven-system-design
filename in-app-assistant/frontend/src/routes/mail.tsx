import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ComposeDialog } from '@/components/mail/ComposeDialog'
import { ThreadView } from '@/components/mail/ThreadView'
import { DraftIcon, InboxIcon, PlusIcon, SendIcon, SparkleIcon } from '@/components/icons'
import { Loading } from '@/components/shared/Loading'
import { shortDate } from '@/lib/format'
import { api } from '@/services/api'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Draft, MailMessage } from '@/types'

type Folder = 'inbox' | 'sent' | 'drafts'

export const Route = createFileRoute('/mail')({
  validateSearch: (search: Record<string, unknown>): { folder?: Folder; m?: string; d?: string } => ({
    folder: ['inbox', 'sent', 'drafts'].includes(String(search.folder)) ? (search.folder as Folder) : undefined,
    m: typeof search.m === 'string' ? search.m : undefined,
    d: typeof search.d === 'string' ? search.d : undefined,
  }),
  component: MailPage,
})

function MailPage() {
  const { folder = 'inbox', m, d } = Route.useSearch()
  const navigate = useNavigate()
  const revision = useWorkspaceStore((s) => s.revision)
  const setOpenMessage = useWorkspaceStore((s) => s.setOpenMessage)
  const [messages, setMessages] = useState<MailMessage[] | null>(null)
  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const [composing, setComposing] = useState(false)

  useEffect(() => {
    setOpenMessage(m ?? null)
    return () => setOpenMessage(null)
  }, [m, setOpenMessage])
  useEffect(() => {
    if (folder === 'drafts') api.drafts().then((r) => setDrafts(r.drafts)).catch(() => setDrafts([]))
    else api.messages(folder).then((r) => setMessages(r.messages)).catch(() => setMessages([]))
  }, [folder, revision])

  const go = (search: { folder?: Folder; m?: string; d?: string }) => void navigate({ to: '/mail', search })
  const folderButton = (key: Folder, label: string, Icon: typeof InboxIcon) => (
    <button type="button" onClick={() => go({ folder: key === 'inbox' ? undefined : key })} className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm ${folder === key ? 'bg-accent-50 font-medium text-accent-700' : 'text-slate-600 hover:bg-slate-100'}`}>
      <Icon className="h-4 w-4" /> {label}
    </button>
  )

  return (
    <div className="flex h-full">
      <div className="w-44 shrink-0 space-y-1 border-r border-slate-200 p-3">
        <button type="button" className="btn-primary mb-3 w-full" onClick={() => setComposing(true)}><PlusIcon /> Compose</button>
        {folderButton('inbox', 'Inbox', InboxIcon)}
        {folderButton('sent', 'Sent', SendIcon)}
        {folderButton('drafts', 'Drafts', DraftIcon)}
      </div>
      <div className="w-[340px] shrink-0 overflow-y-auto border-r border-slate-200">
        {folder === 'drafts' ? (
          drafts === null ? <Loading /> : drafts.length === 0 ? <p className="p-4 text-sm text-slate-500">No drafts.</p> : (
            <ul>
              {drafts.map((draft) => (
                <li key={draft.id}>
                  <button type="button" onClick={() => go({ folder: 'drafts', d: draft.id })} className={`block w-full border-b border-slate-100 px-4 py-3 text-left hover:bg-slate-50 ${d === draft.id ? 'bg-accent-50' : ''}`}>
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate font-medium text-slate-900">To {draft.to.join(', ')}</span>
                      {draft.createdBy === 'assistant' && <span className="chip shrink-0 bg-accent-50 text-accent-700"><SparkleIcon className="h-3 w-3" /> Assistant</span>}
                    </div>
                    <div className="truncate text-sm text-slate-700">{draft.subject}</div>
                    <div className="truncate text-xs text-slate-400">{draft.body}</div>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : messages === null ? <Loading /> : (
          <ul aria-label="Messages">
            {messages.map((msg) => (
              <li key={msg.id}>
                <button type="button" onClick={() => go({ folder: folder === 'inbox' ? undefined : folder, m: msg.id })} className={`block w-full border-b border-slate-100 px-4 py-3 text-left hover:bg-slate-50 ${m === msg.id ? 'bg-accent-50' : ''}`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`truncate text-sm ${msg.unread ? 'font-semibold text-slate-900' : 'text-slate-700'}`}>{folder === 'sent' ? `To ${msg.to.join(', ')}` : msg.from.name}</span>
                    <time className="shrink-0 text-xs text-slate-400">{shortDate(msg.sentAt)}</time>
                  </div>
                  <div className="flex items-center gap-1.5 truncate text-sm text-slate-700">
                    {msg.external && <span className="chip shrink-0 bg-amber-50 px-1.5 text-[10px] text-amber-700">External</span>}
                    <span className="truncate">{msg.subject}</span>
                  </div>
                  <div className="truncate text-xs text-slate-400">{msg.snippet}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {folder === 'drafts' && d ? <DraftView draft={drafts?.find((x) => x.id === d)} /> : m ? <ThreadView messageId={m} /> : (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">Select a message</div>
        )}
      </div>
      {composing && <ComposeDialog onClose={() => setComposing(false)} />}
    </div>
  )
}

function DraftView({ draft }: { draft?: Draft }) {
  const bump = useWorkspaceStore((s) => s.bump)
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  if (!draft) return <div className="p-6 text-sm text-slate-400">This draft was sent or discarded.</div>
  return (
    <div className="space-y-3 px-6 py-5">
      {draft.createdBy === 'assistant' && <div className="chip bg-accent-50 text-accent-700"><SparkleIcon className="h-3 w-3" /> Drafted by the assistant</div>}
      <div className="text-sm text-slate-500">To <span className="text-slate-900">{draft.to.join(', ')}</span></div>
      <h2 className="text-lg font-semibold text-slate-900">{draft.subject}</h2>
      <div className="whitespace-pre-line rounded-lg border border-slate-200 p-4 text-sm text-slate-700">{draft.body}</div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={() => api.sendDraft(draft.id).then(() => { bump(); void navigate({ to: '/mail', search: { folder: 'sent' } }) }).catch((e) => setError(e.message))}><SendIcon /> Send</button>
        <button type="button" className="btn-secondary" onClick={() => api.discardDraft(draft.id).then(() => { bump(); void navigate({ to: '/mail', search: { folder: 'drafts' } }) })}>Discard</button>
      </div>
    </div>
  )
}
