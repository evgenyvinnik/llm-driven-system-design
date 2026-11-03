import { useState, type FormEvent } from 'react'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { ApiError } from '@/services/api'
import { useAuth } from '@/stores/auth-store'

interface LoginSearch {
  redirect?: string
}

/** Only same-origin paths: an open redirect on the sign-in page would be a phishing gift. */
function safeRedirect(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/login')
    ? value
    : undefined
}

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({ redirect: safeRedirect(search.redirect) }),
  component: LoginPage,
})

const DEMO = ['alice@example.com', 'ben@example.com', 'dev@example.com', 'chloe@example.com']

function LoginPage() {
  const { redirect } = Route.useSearch()
  const login = useAuth((s) => s.login)
  const endedReason = useAuth((s) => s.endedReason)
  const navigate = useNavigate()
  const router = useRouter()
  const [email, setEmail] = useState('alice@example.com')
  const [password, setPassword] = useState('password123')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(email, password)
      if (redirect) router.history.push(redirect)
      else void navigate({ to: '/' })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
        <div>
          <p className="text-sm font-semibold text-slate-900">Relay Console</p>
          <h1 className="mt-1 text-lg font-semibold">Sign in</h1>
          {endedReason && <p className="mt-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900">{endedReason}</p>}
          {redirect && !endedReason && <p className="mt-1 text-sm text-slate-500">You'll go back to the page you were on.</p>}
        </div>
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input id="email" name="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </div>
        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="text-xs text-slate-500">
          Demo accounts (password <code>password123</code>):{' '}
          {DEMO.map((d, i) => (
            <span key={d}>
              <button type="button" className="underline" onClick={() => setEmail(d)}>
                {d.split('@')[0]}
              </button>
              {i < DEMO.length - 1 ? ', ' : ''}
            </span>
          ))}
        </p>
      </form>
    </main>
  )
}
