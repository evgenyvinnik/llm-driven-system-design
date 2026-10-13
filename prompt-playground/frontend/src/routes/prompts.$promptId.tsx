import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { RequireAuth } from '@/components/layout'
import {
  ConfigPanel,
  ConflictBanner,
  EditorPanel,
  OutputArea,
  RunHistory,
  ShareDialog,
  VariablesPanel,
  VersionBar,
  type ShareTarget,
} from '@/components/playground'
import { ErrorNote, Loading } from '@/components/shared'
import { usePlaygroundDraft } from '@/hooks/usePlaygroundDraft'
import { usePromptDetail } from '@/hooks/usePromptDetail'
import { useRunLauncher } from '@/hooks/useRunLauncher'
import { api, ApiError } from '@/services/api'
import { useRuns } from '@/stores/runs-store'
import { useToasts } from '@/stores/toast-store'

interface PlaygroundSearch {
  /** Selected run or comparison; in the URL so a refresh or a shared link reopens it. */
  run?: string
}

export const Route = createFileRoute('/prompts/$promptId')({
  validateSearch: (search: Record<string, unknown>): PlaygroundSearch => ({
    run: typeof search.run === 'string' ? search.run : undefined,
  }),
  component: () => (
    <RequireAuth>
      <PlaygroundPage />
    </RequireAuth>
  ),
})

function PlaygroundPage() {
  const { promptId } = Route.useParams()
  const { run: selection } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { detail, error, reload } = usePromptDetail(promptId)
  const { draft, patch, dirty, headMoved, variableNames, missing } = usePlaygroundDraft(promptId, detail)
  const title = detail?.prompt.title ?? ''
  const launcher = useRunLauncher(promptId, title)
  const setViewing = useRuns((s) => s.setViewing)
  const pushToast = useToasts((s) => s.push)
  const [refreshKey, setRefreshKey] = useState(0)
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null)
  const [saving, setSaving] = useState(false)

  // Runs that finish while this prompt is open don't need a toast.
  useEffect(() => {
    setViewing(promptId, title || undefined)
    return () => setViewing(null)
  }, [promptId, title, setViewing])

  if (error) {
    return (
      <div className="p-8">
        <ErrorNote message={error} onRetry={() => void reload()} />
      </div>
    )
  }
  if (!detail || !draft) return <Loading />

  const blockedReason = !draft.template.trim()
    ? 'Write a user message first'
    : missing.length > 0
      ? `Fill in: ${missing.join(', ')}`
      : null

  const select = (run: string) => void navigate({ search: { run } })

  async function run() {
    if (!draft || blockedReason || launcher.launching) return
    const selected = await launcher.launch(draft)
    if (selected) {
      select(selected)
      setRefreshKey((k) => k + 1)
    }
  }

  async function save(message: string): Promise<boolean> {
    if (!draft) return false
    setSaving(true)
    try {
      const result = await api.saveVersion(promptId, {
        system: draft.system,
        template: draft.template,
        message,
        baseVersion: draft.baseVersion,
      })
      patch({ baseVersion: result.version.version })
      await reload()
      pushToast({
        message: result.created ? `Saved v${result.version.version}` : `No changes since v${result.version.version}`,
        tone: 'success',
      })
      return true
    } catch (err) {
      // HEAD_MOVED: reloading surfaces the conflict banner with who saved what.
      if (err instanceof ApiError && err.code === 'HEAD_MOVED') await reload()
      pushToast({ message: err instanceof ApiError ? err.message : 'Save failed', tone: 'error' })
      return false
    } finally {
      setSaving(false)
    }
  }

  async function loadVersion(version: number) {
    if (!detail) return
    if (dirty && !window.confirm(`Replace your unsaved edits with v${version}?`)) return
    const { version: v } = await api.getVersion(promptId, version)
    // Loading an older version is a restore: saving puts its text on top of the current head.
    patch({ system: v.system, template: v.template, baseVersion: detail.prompt.headVersion })
  }

  const head = detail.head
  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      <VersionBar
        detail={detail}
        dirty={dirty}
        saving={saving}
        onLoadVersion={(v) => void loadVersion(v)}
        onSave={save}
        onShareVersion={() => setShareTarget({ kind: 'version', version: detail.prompt.headVersion })}
      />
      {headMoved && head && (
        <ConflictBanner
          head={head}
          onDiscardMine={() => patch({ system: head.system, template: head.template, baseVersion: head.version })}
          onKeepMine={() => patch({ baseVersion: head.version })}
        />
      )}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,5fr)_minmax(0,7fr)_17rem] gap-4 p-4">
        <section className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
          <EditorPanel draft={draft} onChange={patch} onRun={() => void run()} />
          <VariablesPanel names={variableNames} values={draft.variables} missing={missing} onChange={(variables) => patch({ variables })} />
        </section>
        <section className="flex min-h-0 flex-col gap-4">
          <div className="flex min-h-0 flex-[3] flex-col">
            <OutputArea selection={selection} promptTitle={title} onShareRun={(runId) => setShareTarget({ kind: 'run', runId })} />
          </div>
          <div className="flex min-h-0 flex-[2] flex-col">
            <RunHistory promptId={promptId} selection={selection} onSelect={select} refreshKey={refreshKey} />
          </div>
        </section>
        <aside className="min-h-0 overflow-y-auto">
          <ConfigPanel
            configs={draft.configs}
            onChange={(configs) => patch({ configs })}
            onRun={() => void run()}
            launching={launcher.launching}
            blockedReason={blockedReason}
            error={launcher.error}
          />
        </aside>
      </div>
      {shareTarget && <ShareDialog promptId={promptId} target={shareTarget} onClose={() => setShareTarget(null)} />}
    </div>
  )
}
