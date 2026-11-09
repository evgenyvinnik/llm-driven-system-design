import { useState, type FormEvent } from 'react'
import { ErrorNote } from '@/components/shared/Feedback'
import { api } from '@/services/api'
import type { Environment } from '@/types'

/** Write-only: the value goes up once and the field is cleared. Nothing ever comes back. */
export function SecretForm({ repoId, environments, onSaved }: { repoId: string; environments: Environment[]; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [environment, setEnvironment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSaved(null)
    try {
      await api.saveSecret(repoId, { name, value, environment: environment || null })
      setSaved(`${name} saved. Its value can never be read back.`)
      setName('')
      setValue('')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the secret')
    }
  }

  return (
    <form className="grid gap-3 p-4 md:grid-cols-[1fr_1fr_auto_auto]" onSubmit={(e) => void submit(e)} aria-label="Add or rotate a secret">
      <div>
        <label className="label" htmlFor="secret-name">
          Name
        </label>
        <input id="secret-name" className="input font-mono" placeholder="DEPLOY_TOKEN" value={name} onChange={(e) => setName(e.target.value.toUpperCase())} required />
      </div>
      <div>
        <label className="label" htmlFor="secret-value">
          Value
        </label>
        <input id="secret-value" className="input font-mono" type="password" autoComplete="off" placeholder="At least 6 characters" value={value} onChange={(e) => setValue(e.target.value)} required />
      </div>
      <div>
        <label className="label" htmlFor="secret-scope">
          Scope
        </label>
        <select id="secret-scope" className="input" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
          <option value="">Repository</option>
          {environments.map((env) => (
            <option key={env.id} value={env.name}>
              Environment: {env.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-end">
        <button type="submit" className="btn-primary" disabled={!name || !value}>
          Save
        </button>
      </div>
      {error && (
        <div className="md:col-span-4">
          <ErrorNote message={error} />
        </div>
      )}
      {saved && <div className="text-sm text-emerald-800 md:col-span-4">{saved}</div>}
    </form>
  )
}
