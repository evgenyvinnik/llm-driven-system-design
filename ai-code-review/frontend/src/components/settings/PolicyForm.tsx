import { useState } from 'react'
import { ErrorNote } from '@/components/shared/Loading'
import { api } from '@/services/api'
import type { Repo } from '@/types'

const lines = (v: string[]) => v.join('\n')
const parse = (v: string) => v.split('\n').map((x) => x.trim()).filter(Boolean)

function PathList({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <textarea className="input h-24 font-mono !text-xs" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
    </label>
  )
}

export function PolicyForm({ repo, modelVersions, editable, onSaved }: { repo: Repo; modelVersions: string[]; editable: boolean; onSaved: () => void }) {
  const [protectedPaths, setProtected] = useState(lines(repo.protectedPaths))
  const [ciPaths, setCi] = useState(lines(repo.ciConfigPaths))
  const [policyPaths, setPolicy] = useState(lines(repo.policyPaths))
  const [reviewers, setReviewers] = useState(lines(repo.requiredReviewers))
  const [checks, setChecks] = useState(lines(repo.requiredChecks))
  const [maxFiles, setMaxFiles] = useState(repo.maxFiles)
  const [maxLines, setMaxLines] = useState(repo.maxChangedLines)
  const [scope, setScope] = useState(repo.autoApproveScope)
  const [model, setModel] = useState(repo.modelVersion)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function save() {
    setError(null)
    setSaved(false)
    try {
      await api.updateRepo(repo.id, { protectedPaths: parse(protectedPaths), ciConfigPaths: parse(ciPaths), policyPaths: parse(policyPaths), requiredReviewers: parse(reviewers), requiredChecks: parse(checks), maxFiles, maxChangedLines: maxLines, autoApproveScope: scope, modelVersion: model })
      setSaved(true)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    }
  }
  const toggle = (c: 'docs' | 'tests') => setScope(scope.includes(c) ? scope.filter((x) => x !== c) : [...scope, c])
  const off = !editable

  return (
    <section className="card space-y-3 p-4" aria-label="Policy">
      <div className="flex items-baseline justify-between">
        <h2 className="panel-title">Policy, version {repo.settingsVersion}</h2>
        <span className="text-xs text-slate-500">Held here and audited. Never read from the repository.</span>
      </div>
      {error && <ErrorNote message={error} />}
      <div className="grid gap-3 md:grid-cols-3">
        <PathList label="Protected paths" value={protectedPaths} onChange={setProtected} disabled={off} />
        <PathList label="CI configuration paths" value={ciPaths} onChange={setCi} disabled={off} />
        <PathList label="Policy files" value={policyPaths} onChange={setPolicy} disabled={off} />
        <PathList label="Required checks" value={checks} onChange={setChecks} disabled={off} />
        <PathList label="Required reviewers" value={reviewers} onChange={setReviewers} disabled={off} />
        <div className="space-y-2">
          <label className="block"><span className="label">Max files</span><input type="number" className="input" value={maxFiles} min={1} onChange={(e) => setMaxFiles(Number(e.target.value))} disabled={off} /></label>
          <label className="block"><span className="label">Max changed lines</span><input type="number" className="input" value={maxLines} min={1} onChange={(e) => setMaxLines(Number(e.target.value))} disabled={off} /></label>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <fieldset className="flex items-center gap-3 text-sm" disabled={off}>
          <legend className="label float-left mr-2 !mb-0">Auto-approve scope</legend>
          {(['docs', 'tests'] as const).map((c) => <label key={c} className="flex items-center gap-1"><input type="checkbox" checked={scope.includes(c)} onChange={() => toggle(c)} /> {c}</label>)}
        </fieldset>
        <label className="flex items-center gap-2 text-sm"><span className="label !mb-0">Pinned model</span>
          <select className="input !w-44" value={model} onChange={(e) => setModel(e.target.value)} disabled={off}>{modelVersions.map((v) => <option key={v} value={v}>{v}</option>)}</select>
        </label>
        {editable && <button type="button" className="btn-primary" onClick={() => void save()}>Save policy</button>}
        {saved && <span className="text-sm text-emerald-700">Saved and audited.</span>}
      </div>
      {model !== repo.modelVersion && <p className="text-xs text-amber-800">Changing the model drops this repository back to observe: evidence for one version says nothing about another.</p>}
    </section>
  )
}
