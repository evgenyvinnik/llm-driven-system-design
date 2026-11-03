import { useState, type FormEvent } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ApiError } from '../lib/api'
import { useSession } from '../stores/session'

export const Route = createFileRoute('/login')({ component: Login })

const DEMO = [
  { user: 'alice', note: 'Admin at Larkspur (sees cost), analyst at Kestrel' },
  { user: 'bob', note: 'Analyst at Larkspur: no cost columns' },
  { user: 'carol', note: 'Admin at Kestrel (UTC+5:30) and Tiny Atelier (4 users)' },
  { user: 'dana', note: 'Support staff: every org, no cost, no drill-down' },
]

function Login() {
  const login = useSession((s) => s.login)
  const navigate = useNavigate()
  const [username, setUsername] = useState('alice')
  const [password, setPassword] = useState('password123')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(username, password)
      navigate({ to: '/' })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-xl font-semibold">Chat Analytics</h1>
        <p className="mb-6 text-sm text-ink-2">Usage, latency, reliability and cost for a fictitious chat product.</p>
        <form onSubmit={submit} className="card space-y-3 p-5">
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
          {error && <p className="text-sm text-status-critical">{error}</p>}
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <div className="mt-4 text-xs text-ink-2">
          <p className="mb-1 font-medium text-ink">Demo users (password123)</p>
          <ul className="space-y-0.5">
            {DEMO.map((d) => (
              <li key={d.user}>
                <button type="button" className="font-mono text-series-1 hover:underline" onClick={() => setUsername(d.user)}>
                  {d.user}
                </button>{' '}
                · {d.note}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
