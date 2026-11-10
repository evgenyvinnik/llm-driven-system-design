/**
 * The handheld's offline queue. A report gets its id on the device when the crew
 * taps, so retries and a late sync can't double-apply. It survives a reload, because
 * a phone in a yard runs out of signal and battery at the worst times. Browser
 * storage can be missing or refuse writes, so every access is guarded and the
 * queue still works in memory.
 */
import type { CrewReportInput } from '@/types'

const KEY = 'yard-crew-outbox'
let memory: CrewReportInput[] = []

function read(): CrewReportInput[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as CrewReportInput[]) : memory
  } catch {
    return memory
  }
}

function write(list: CrewReportInput[]) {
  memory = list
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // Storage is unavailable: the in-memory copy still holds it until a reload.
  }
}

export function newReportId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

export const outbox = {
  list: read,
  add(report: CrewReportInput) {
    write([...read(), report])
  },
  remove(ids: string[]) {
    const gone = new Set(ids)
    write(read().filter((r) => !gone.has(r.clientReportId)))
  },
  /** Local view of what's already been done offline, so the screen moves on before sync. */
  localStatus(moveKey: string): 'in_progress' | 'done' | null {
    const list = read().filter((r) => r.moveKey === moveKey)
    if (list.some((r) => r.kind === 'complete' || r.kind === 'exception')) return 'done'
    if (list.some((r) => r.kind === 'start')) return 'in_progress'
    return null
  },
}
