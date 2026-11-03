import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ChatIcon } from '@/components/icons'
import { useAuth } from '@/stores/auth-store'

export const Route = createFileRoute('/login')({ component: LoginPage })

function LoginPage() {
  const login = useAuth((s) => s.login)
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(username, password)
      void navigate({ to: '/' })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2">
          <ChatIcon className="h-6 w-6 text-accent-600" />
          <h1 className="text-lg font-semibold text-slate-900">Sign in to AI Chat</h1>
        </div>
        <label className="label" htmlFor="username">
          Username
        </label>
        <input
          id="username"
          name="username"
          className="input mb-3"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          className="input mb-4"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p className="mb-3 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn-primary w-full" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="mt-4 text-xs text-slate-500">
          Demo accounts: <code>alice</code>, <code>bob</code> or <code>admin</code>, password <code>password123</code>.
        </p>
      </form>
    </main>
  )
}
