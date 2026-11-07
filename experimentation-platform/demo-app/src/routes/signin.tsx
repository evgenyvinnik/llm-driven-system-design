import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { useClientState } from 'experimentation-sdk/react'
import { signedIn, signedOut } from '@/lib/experiments'
import { useShop, type Shopper } from '@/stores/shop-store'

export const Route = createFileRoute('/signin')({ component: SignIn })

const SHOPPERS = [
  { username: 'carol', who: 'US, free plan' },
  { username: 'dave', who: 'Canada, pro plan' },
  { username: 'erin', who: 'Germany, free plan' },
]

function SignIn() {
  const user = useShop((s) => s.user)
  const setUser = useShop((s) => s.setUser)
  const { context } = useClientState()
  const navigate = useNavigate()
  const [username, setUsername] = useState('carol')
  const [password, setPassword] = useState('password123')
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    // The anonymous id goes with the sign-in: the shop's server links it to the
    // user and returns the stable id the SDK must bucket by from now on.
    const res = await fetch('/api/v1/shop/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, anonymousId: context.anonymousId }) })
    const body = (await res.json()) as { user?: Shopper; stableId?: string; error?: { message: string } }
    if (!res.ok || !body.user || !body.stableId) {
      setError(body.error?.message ?? 'Sign in failed')
      return
    }
    setUser(body.user)
    signedIn({ userId: body.user.id, stableId: body.stableId, orgId: body.user.orgId, country: body.user.country, plan: body.user.plan })
    void navigate({ to: '/' })
  }

  async function signOut() {
    await fetch('/api/v1/shop/logout', { method: 'POST' }).catch(() => undefined)
    setUser(null)
    signedOut()
  }

  if (user) {
    return (
      <div className="card mx-auto max-w-md space-y-3 p-6" data-page="account">
        <h1 className="font-display text-2xl font-bold">Hi, {user.displayName}</h1>
        <p className="text-sm text-stone-600">
          Experiments bucketed by user use your stable id <code className="font-mono">{context.stableId}</code>: the first anonymous id you signed in from, so your variants are the same on every device.
        </p>
        <button type="button" className="btn-outline" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    )
  }
  return (
    <form onSubmit={submit} className="card mx-auto max-w-md space-y-4 p-6" data-page="signin">
      <h1 className="font-display text-2xl font-bold">Sign in</h1>
      <p className="text-sm text-stone-600">You keep the variants you saw as a guest: the platform links this browser’s anonymous id to your account.</p>
      <input className="input" name="username" value={username} onChange={(e) => setUsername(e.target.value)} aria-label="Username" />
      <input className="input" name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" />
      {error && <p className="text-sm text-rose-700">{error}</p>}
      <button type="submit" className="btn-brand w-full">
        Sign in
      </button>
      <div className="space-y-1 border-t border-brand-100 pt-3 text-xs text-stone-500">
        <p>Demo shoppers (password password123):</p>
        {SHOPPERS.map((s) => (
          <button key={s.username} type="button" className="block hover:text-brand-700" onClick={() => setUsername(s.username)}>
            <span className="font-mono">{s.username}</span> · {s.who}
          </button>
        ))}
      </div>
    </form>
  )
}
