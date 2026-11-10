/**
 * A narrated walk through the hard problems against a running stack:
 *   npm run demo:story
 * Signs in as carol and drives the fixture panel's API, so every step is something
 * you can also do from the browser. Run `npm run db:seed` first.
 */
const API = process.env.API_URL || `http://localhost:${process.env.PORT || 3000}`
const REPO = 'acme/web-app'
let cookie = ''

async function call<T = Record<string, never>>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (path === '/auth/login') cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } }
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error?.message ?? res.status}`)
  return data
}

interface Detail {
  pr: { headSha: string }
  runs: { status: string; parsedOutput: { verdict: string; confidence: number } | null }[]
  decisions: { state: string; headSha: string; outcome: string; reason: string; modelOverruled: boolean }[]
  intents: { status: string }[]
  hostReviews: { state: string; commit_id: string; dismissed: boolean }[] | null
}

const detail = (n: number) => call<Detail>('GET', `/prs/${REPO}/${n}`)

/** Waits for the review of this head, and whatever it queued for the host, to finish. Pass the SHA after a push: the webhook may not have arrived yet. */
async function settled(n: number, sha?: string): Promise<Detail & { active: Detail['decisions'][number] }> {
  for (let i = 0; i < 200; i++) {
    const d = await detail(n).catch(() => null)
    const active = d?.decisions.find((x) => x.state === 'active')
    if (d && active && active.headSha === d.pr.headSha && (!sha || d.pr.headSha === sha) && !d.runs.some((r) => ['queued', 'running'].includes(r.status)) && !d.intents.some((x) => ['pending', 'running'].includes(x.status))) return { ...d, active }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`#${n} did not settle. Is the whole stack running?`)
}

const say = (s: string) => console.log(`\n${s}`)
const liveApprovals = (d: Detail) => (d.hostReviews ?? []).filter((r) => r.state === 'APPROVED' && !r.dismissed).map((r) => r.commit_id.slice(0, 7))

await call('POST', '/auth/login', { username: 'carol', password: 'password123' })

say('1. A safe docs change: the gate passes, the model approves, and the approval names one commit.')
const safe = await call<{ number: number; headSha: string }>('POST', `/fixtures/${REPO}/pulls`, { fixture: 'docs-safe' })
const a = await settled(safe.number, safe.headSha)
console.log(`   #${safe.number} ${a.active.outcome}. Live approvals at the host: ${liveApprovals(a)}, head ${safe.headSha.slice(0, 7)}`)

say('2. A push to the approved branch: the approval is invalidated and dismissed, and the new commit stands on its own.')
const pushed = await call<{ headSha: string }>('POST', `/fixtures/${REPO}/pulls/${safe.number}/push`, { kind: 'risky' })
const b = await settled(safe.number, pushed.headSha)
console.log(`   Now at ${pushed.headSha.slice(0, 7)}: ${b.active.outcome}. ${b.active.reason}`)
console.log(`   Live approvals at the host: ${liveApprovals(b).length}`)

say('3. A prompt injection: the model really falls for it, and the gate refuses anyway.')
const inj = await call<{ number: number }>('POST', `/fixtures/${REPO}/pulls`, { fixture: 'injection-diff' })
const c = await settled(inj.number)
console.log(`   Model: ${c.runs[0].parsedOutput?.verdict} at ${c.runs[0].parsedOutput?.confidence}. Decision: ${c.active.outcome}, model overruled: ${c.active.modelOverruled}`)
console.log(`   ${c.active.reason}`)

say('4. A request for .env: denied, audited, and the secret never reaches the model.')
const exfil = await call<{ number: number }>('POST', `/fixtures/${REPO}/pulls`, { fixture: 'injection-exfil' })
await settled(exfil.number)
const denied = await call<{ entries: { payload: { input: { path: string }; denialReason: string } }[] }>('GET', `/audit?repo=${REPO}&pr=${exfil.number}&kind=tool_denied`)
for (const e of denied.entries) console.log(`   Denied ${e.payload.input.path}: ${e.payload.denialReason}`)

say('5. A model outage: this fails closed, into the human queue.')
await call('PATCH', '/system/model', { failureRate: 1 })
const down = await call<{ number: number }>('POST', `/fixtures/${REPO}/pulls`, { fixture: 'docs-safe' })
const e = await settled(down.number)
await call('PATCH', '/system/model', { failureRate: 0 })
console.log(`   ${e.active.outcome}: ${e.active.reason}`)

say('6. The same corpus through the proposal and through the corrected design.')
const { evaluation } = await call<{ evaluation: { summary: { modelOnly: { dangerous: { falseApprovals: number; total: number } }; modelPlusGate: { dangerous: { falseApprovals: number; total: number; upperBound95: number } } } } }>('POST', '/evaluations', { modelVersion: 'mock-reviewer-1' })
const { modelOnly, modelPlusGate } = evaluation.summary
console.log(`   Model only: ${modelOnly.dangerous.falseApprovals} of ${modelOnly.dangerous.total} dangerous changes approved`)
console.log(`   Model + gate: ${modelPlusGate.dangerous.falseApprovals} of ${modelPlusGate.dangerous.total}, 95% upper bound ${(modelPlusGate.dangerous.upperBound95 * 100).toFixed(1)}%`)

say('7. The audit chain: every step above is in it, and it verifies.')
const verified = await call<{ ok: boolean; chains: { repo: string; checked: number }[] }>('POST', '/audit/verify', {})
for (const chain of verified.chains) console.log(`   ${chain.repo}: ${chain.checked} entries`)
console.log(`   All chains verify: ${verified.ok}`)
