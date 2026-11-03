/**
 * Client tools: run here, in the browser, because only the browser has the
 * live editor state or controls what's on screen. The result is posted back
 * to the server, which resumes the turn.
 */
import { useWorkspaceStore } from '@/stores/workspace-store'

type Navigate = (to: string) => void
let navigate: Navigate = (to) => window.location.assign(to)

export function setNavigator(fn: Navigate): void {
  navigate = fn
}

export async function runClientTool(name: string, input: Record<string, unknown>): Promise<{ output: Record<string, unknown> } | { error: string }> {
  if (name === 'get_selection') {
    const { openDocument: doc, selection } = useWorkspaceStore.getState()
    if (!doc) return { error: 'No document is open in the editor. Ask the user to open one.' }
    return {
      output: {
        doc_id: doc.id,
        title: doc.title,
        doc_version: doc.version,
        paragraphs: doc.paragraphs.filter((p) => selection.includes(p.id)).map((p) => ({ id: p.id, kind: p.kind, text: p.text })),
      },
    }
  }
  if (name === 'open_item') {
    const id = String(input.id)
    const routes: Record<string, string> = {
      message: `/mail?m=${id}`,
      doc: `/docs/${id}`,
      event: `/calendar?e=${id}`,
      draft: `/mail?folder=drafts&d=${id}`,
    }
    const to = routes[String(input.kind)]
    if (!to) return { error: `Can't open a ${input.kind}.` }
    navigate(to)
    return { output: { opened: true, kind: input.kind, id } }
  }
  return { error: `The browser has no tool named ${name}.` }
}
