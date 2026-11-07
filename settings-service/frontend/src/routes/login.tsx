import { createFileRoute } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { ApiError } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/login')({ component: LoginPage })

const DEMO = [
  { username: 'alice', who: 'Acme member' },
  { username: 'dave', who: 'Globex member' },
  { username: 'admin', who: 'Acme platform admin' },
  { username: 'grace', who: 'Globex org admin' },
]

function LoginPage() {
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
      setError(err instanceof ApiError ? err.body.message : 'Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-page px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="h-10 w-10" />
          <div>
            <h1 className="text-lg font-semibold text-ink">Settings service</h1>
            <p className="text-sm text-muted">Preferences, org policy and sync</p>
          </div>
        </div>
        <form onSubmit={submit} className="card space-y-4 p-6">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-ink">Username</span>
            <input name="username" className="field w-full" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-ink">Password</span>
            <input name="password" type="password" className="field w-full" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
          <button type="submit" className="btn-primary w-full justify-center py-2" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <div className="mt-4 rounded-xl border border-dashed border-line p-4 text-xs text-muted">
          <p className="mb-2 font-medium text-ink">Demo accounts (password123)</p>
          <ul className="grid grid-cols-2 gap-1">
            {DEMO.map((d) => (
              <li key={d.username}>
                <button type="button" className="text-left hover:text-accent-700" onClick={() => setUsername(d.username)}>
                  <span className="font-mono text-ink">{d.username}</span> · {d.who}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </main>
  )
}
