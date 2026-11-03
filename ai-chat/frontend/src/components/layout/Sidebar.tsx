import { Link, useNavigate } from '@tanstack/react-router'
import { ChatIcon, GaugeIcon, LogoutIcon, PencilIcon, PlusIcon, SpinnerIcon, TrashIcon, WifiOffIcon } from '@/components/icons'
import { groupByRecency } from '@/lib/format'
import { api } from '@/services/api'
import { useAuth } from '@/stores/auth-store'
import { useConnectivity } from '@/stores/connectivity-store'
import { useConversations } from '@/stores/conversations-store'
import { useUi } from '@/stores/ui-store'
import type { Conversation } from '@/types'

export function Sidebar() {
  const list = useConversations((s) => s.list)
  const listSource = useConversations((s) => s.listSource)
  const nextCursor = useConversations((s) => s.nextCursor)
  const loadMore = useConversations((s) => s.loadMoreList)
  const online = useConnectivity((s) => s.online)
  const user = useAuth((s) => s.user)
  const logout = useAuth((s) => s.logout)
  const navigate = useNavigate()

  return (
    <aside className="flex h-screen w-72 shrink-0 flex-col border-r border-slate-200 bg-slate-50" aria-label="Conversations">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <Link to="/" className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          <ChatIcon className="h-5 w-5 text-accent-600" />
          AI Chat
        </Link>
        <Link to="/" className="btn-secondary !px-2 !py-1 text-xs" aria-label="New chat">
          <PlusIcon className="h-3.5 w-3.5" /> New chat
        </Link>
      </div>

      {(!online || listSource === 'cache') && (
        <div className="mx-3 mb-2 flex items-start gap-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800" role="status">
          <WifiOffIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Offline. Showing conversations saved on this device, read-only.</span>
        </div>
      )}

      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        {groupByRecency(list).map((group) => (
          <section key={group.label} className="mt-3">
            <h2 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{group.label}</h2>
            <ul>
              {group.items.map((c) => (
                <ConversationItem key={c.id} conversation={c} />
              ))}
            </ul>
          </section>
        ))}
        {nextCursor && online && (
          <button type="button" onClick={() => void loadMore()} className="btn-ghost mt-2 w-full text-xs">
            Load older conversations
          </button>
        )}
      </nav>

      <div className="flex items-center justify-between border-t border-slate-200 px-3 py-2 text-sm">
        <span className="truncate text-slate-700" title={user?.username}>
          {user?.displayName}
        </span>
        <div className="flex items-center gap-1">
          {user?.role === 'admin' && (
            <Link to="/admin" className="btn-icon" aria-label="Operator dashboard" title="Operator dashboard">
              <GaugeIcon />
            </Link>
          )}
          <button
            type="button"
            className="btn-icon"
            aria-label="Sign out"
            title="Sign out (also removes this device's offline copy)"
            onClick={() => void logout().then(() => navigate({ to: '/login' }))}
          >
            <LogoutIcon />
          </button>
        </div>
      </div>
    </aside>
  )
}

function ConversationItem({ conversation }: { conversation: Conversation }) {
  const unread = useConversations((s) => !!s.unread[conversation.id])
  const online = useConnectivity((s) => s.online)
  const navigate = useNavigate()

  const rename = async () => {
    const title = window.prompt('Rename conversation', conversation.title)?.trim()
    if (!title || title === conversation.title) return
    try {
      const { conversation: updated } = await api.renameConversation(conversation.id, title)
      useConversations.getState().upsertConversation(updated)
    } catch (err) {
      useUi.getState().toast({ message: (err as Error).message, tone: 'error' })
    }
  }

  const remove = async () => {
    if (!window.confirm(`Delete “${conversation.title}”?`)) return
    try {
      await api.deleteConversation(conversation.id)
      useConversations.getState().removeConversation(conversation.id)
      if (useConversations.getState().viewingId === conversation.id) void navigate({ to: '/' })
    } catch (err) {
      useUi.getState().toast({ message: (err as Error).message, tone: 'error' })
    }
  }

  return (
    <li className="group relative">
      <Link
        to="/c/$conversationId"
        params={{ conversationId: conversation.id }}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 pr-14 text-sm text-slate-700 hover:bg-slate-200/60"
        activeProps={{ className: 'bg-slate-200/80 font-medium text-slate-900', 'aria-current': 'page' }}
      >
        <span className="truncate">{conversation.title}</span>
        {conversation.activeGenerationId && (
          <span className="shrink-0 text-accent-600" title="An answer is being written">
            <SpinnerIcon className="h-3 w-3" />
            <span className="sr-only">answer in progress</span>
          </span>
        )}
        {unread && !conversation.activeGenerationId && (
          <span className="h-2 w-2 shrink-0 rounded-full bg-accent-500" title="New answer">
            <span className="sr-only">new answer</span>
          </span>
        )}
      </Link>
      {online && (
        <div className="absolute right-1 top-1 hidden items-center group-focus-within:flex group-hover:flex">
          <button type="button" className="btn-icon !h-6 !w-6" aria-label={`Rename ${conversation.title}`} onClick={() => void rename()}>
            <PencilIcon className="h-3.5 w-3.5" />
          </button>
          <button type="button" className="btn-icon !h-6 !w-6" aria-label={`Delete ${conversation.title}`} onClick={() => void remove()}>
            <TrashIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </li>
  )
}
