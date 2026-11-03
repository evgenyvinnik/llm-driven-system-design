import { CalendarIcon, DocIcon, DraftIcon, MailIcon } from '@/components/icons'
import { useOpenHref } from '@/lib/navigation'
import type { Citation } from '@/types'

const ICONS = { mail: MailIcon, doc: DocIcon, event: CalendarIcon, draft: DraftIcon }

/**
 * A citation renders the app's own record of the item (title, link), looked
 * up by the ID the model cited. An ID the tools never returned can't become
 * a link; it shows as unverified.
 */
export function CitationChip({ id, citation, final }: { id: string; citation?: Citation; final: boolean }) {
  const open = useOpenHref()
  if (citation?.verified && citation.source) {
    const Icon = ICONS[citation.source.kind] ?? DocIcon
    return (
      <button
        type="button"
        onClick={() => open(citation.source!.href)}
        title={`${citation.source.title}${citation.source.subtitle ? ` · ${citation.source.subtitle}` : ''}`}
        className="chip mx-0.5 max-w-[11rem] translate-y-[-1px] bg-accent-50 align-middle text-accent-700 hover:bg-accent-100"
      >
        <Icon className="h-3 w-3 shrink-0" />
        <span className="truncate">{citation.source.title}</span>
      </button>
    )
  }
  if (final) {
    return (
      <span className="chip mx-0.5 bg-slate-100 align-middle text-slate-400 line-through" title="The assistant cited something it never retrieved">
        {id}
      </span>
    )
  }
  return <span className="chip mx-0.5 bg-slate-100 align-middle font-mono text-[10px] text-slate-500">{id}</span>
}
