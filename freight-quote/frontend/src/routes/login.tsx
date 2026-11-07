import { createFileRoute } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { QuoteIcon } from '@/components/icons'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/login')({ component: LoginPage })

const DEMO = [
  { username: 'pat', who: 'Pat Delgado · Prairie Grain Co-op (customer, has a contract on KCK→CHI grain)' },
  { username: 'nina', who: 'Nina Haugen · Northline Lumber (customer, tariff pricing)' },
  { username: 'omar', who: 'Omar Reyes · quote platform ops (knobs, streams, DLQ)' },
  { username: 'ada', who: 'Ada Kowalski · pricing admin (also publishes tariffs and fuel surcharges)' },
]

export function LoginPage() {
  const login = useAuthStore((s) => s.login)
  const [username, setUsername] = useState('pat')
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
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-lg bg-slate-900 p-2 text-amber-400">
            <QuoteIcon className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Freight Quotes</h1>
            <p className="text-sm text-slate-500">Rate inquiries for carload freight: firm when the network can confirm, indicative when it can't yet.</p>
          </div>
        </div>
        <form onSubmit={submit} className="card space-y-4 p-6">
          <div>
            <label className="label" htmlFor="username">Username</label>
            <input id="username" name="username" className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input id="password" name="password" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 text-xs text-slate-600">
          <div className="mb-2 font-semibold text-slate-700">Demo users (password123)</div>
          <ul className="space-y-1">
            {DEMO.map((d) => (
              <li key={d.username}>
                <button type="button" className="font-mono text-accent-700 hover:underline" onClick={() => setUsername(d.username)}>
                  {d.username}
                </button>{' '}
                {d.who}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
