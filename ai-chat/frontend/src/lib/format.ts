import type { Conversation } from '@/types'

const DAY = 24 * 60 * 60 * 1000

/** Sidebar sections, the way chat apps group history. */
export function groupByRecency(list: Conversation[], now = new Date()): { label: string; items: Conversation[] }[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const groups: { label: string; test: (t: number) => boolean }[] = [
    { label: 'Today', test: (t) => t >= startOfToday },
    { label: 'Yesterday', test: (t) => t >= startOfToday - DAY },
    { label: 'Previous 7 days', test: (t) => t >= startOfToday - 7 * DAY },
    { label: 'Previous 30 days', test: (t) => t >= startOfToday - 30 * DAY },
    { label: 'Older', test: () => true },
  ]
  const out = groups.map((g) => ({ label: g.label, items: [] as Conversation[] }))
  for (const c of list) {
    const t = new Date(c.updatedAt).getTime()
    out[groups.findIndex((g) => g.test(t))].items.push(c)
  }
  return out.filter((g) => g.items.length > 0)
}

export function timeAgo(iso: string | number, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–'
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}
