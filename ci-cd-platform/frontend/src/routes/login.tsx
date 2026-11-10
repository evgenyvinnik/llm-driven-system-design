import { createFileRoute } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { GitBranchIcon } from '@/components/icons'
import { ErrorNote } from '@/components/shared/Feedback'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/login')({ component: Login })

const ACCOUNTS = [
  ['alice', 'maintainer of the Acme repositories'],
  ['carol', 'read-only on the same repositories'],
  ['bob', 'maintainer in another organization'],
  ['admin', 'platform admin: reads everything'],
] as const

function Login() {
  const login = useAuthStore((s) => s.login)
  const [username, setUsername] = useState('alice')
  const [password, setPassword] = useState('password123')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(username, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-md space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-600 text-white">
            <GitBranchIcon className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">CI/CD Platform</h1>
            <p className="text-sm text-slate-500">Runs that survive their runners.</p>
          </div>
        </div>
        <form className="card space-y-3 p-5" onSubmit={(e) => void submit(e)}>
          <div>
            <label className="label" htmlFor="username">
              Username
            </label>
            <input id="username" name="username" className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </div>
          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input id="password" name="password" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </div>
          {error && <ErrorNote message={error} />}
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <div className="card p-4 text-sm text-slate-600">
          <div className="panel-title mb-2">Demo accounts (password: password123)</div>
          <ul className="space-y-1">
            {ACCOUNTS.map(([name, role]) => (
              <li key={name}>
                <button type="button" className="link" onClick={() => setUsername(name)}>
                  {name}
                </button>{' '}
                <span className="text-slate-500">{role}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </main>
  )
}
