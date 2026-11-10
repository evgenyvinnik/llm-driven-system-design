import { createFileRoute } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { FlaskIcon } from '@/components/icons'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/login')({ component: Login })

const ACCOUNTS = [
  { username: 'alice', who: 'Alice Romero, admin (edits, kill switch)' },
  { username: 'maya', who: 'Maya Chen, admin (growth PM)' },
  { username: 'bob', who: 'Bob Tanaka, viewer (read-only)' },
]

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
      setError(err instanceof Error ? err.message : 'Sign in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-600 text-white">
            <FlaskIcon className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Experiments Console</h1>
            <p className="text-xs text-slate-500">Flags, experiments, results and the kill switch</p>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="username">Username</label>
          <input id="username" name="username" className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input id="password" name="password" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </div>
        {error && <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500">
          <p>Demo accounts (password <code>password123</code>):</p>
          {ACCOUNTS.map((a) => (
            <button key={a.username} type="button" className="block text-left hover:text-accent-700" onClick={() => setUsername(a.username)}>
              <span className="font-mono">{a.username}</span> · {a.who}
            </button>
          ))}
        </div>
      </form>
    </main>
  )
}
