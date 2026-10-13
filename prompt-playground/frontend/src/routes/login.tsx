import { useState, type FormEvent } from 'react'
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router'
import { TerminalIcon } from '@/components/icons'
import { ErrorNote } from '@/components/shared'
import { ApiError } from '@/services/api'
import { useAuth } from '@/stores/auth-store'

export const Route = createFileRoute('/login')({ component: LoginPage })

function LoginPage() {
  const status = useAuth((s) => s.status)
  const login = useAuth((s) => s.login)
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (status === 'authenticated') return <Navigate to="/" />

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(username.trim(), password)
      void navigate({ to: '/' })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2 text-lg font-semibold">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-accent-600 text-white">
            <TerminalIcon />
          </span>
          Prompt Playground
        </div>
        <form onSubmit={submit} className="card space-y-4 p-6 shadow-sm">
          <div>
            <label className="label" htmlFor="username">
              Username
            </label>
            <input id="username" name="username" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input id="password" name="password" type="password" className="input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <ErrorNote message={error} />}
          <button type="submit" className="btn-primary w-full py-2" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="mt-4 text-center text-xs text-slate-500">
          Demo accounts: <span className="font-mono">alice</span> (admin), <span className="font-mono">bob</span>,{' '}
          <span className="font-mono">carol</span> · password <span className="font-mono">password123</span>
        </p>
      </div>
    </main>
  )
}
