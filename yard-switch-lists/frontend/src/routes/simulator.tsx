import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { PauseIcon, PlayIcon, RefreshIcon } from '@/components/icons'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { clockDay } from '@/lib/format'
import { usePolling } from '@/lib/usePolling'
import { api } from '@/services/api'

export const Route = createFileRoute('/simulator')({ component: SimulatorPage })

function SimulatorPage() {
  const { data: sim, error, refresh } = usePolling(api.simState, 1500)
  const board = usePolling(api.board, 5000).data
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lateTrain, setLateTrain] = useState('')
  const [minutes, setMinutes] = useState(180)
  const [carId, setCarId] = useState('')
  const [trackId, setTrackId] = useState('C4')
  const [seed, setSeed] = useState('')

  const act = async (fn: () => Promise<unknown>, done: (result: unknown) => string) => {
    setBusy(true)
    try {
      setMessage(done(await fn()))
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'That failed')
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  if (error && !sim) return <main className="page"><ErrorNote message={`${error}. Start the simulator with npm run dev:simulator.`} /></main>
  if (!sim) return <Loading />
  const pending = board?.inbound.filter((i) => !i.actualArrival) ?? []
  const seedValue = seed === '' ? sim.seed : Number(seed)
  return (
    <main className="page">
      <h1 className="text-lg font-semibold text-slate-900">Yard simulator</h1>
      <p className="text-sm text-slate-600">A separate process with its own clock, seed {sim.seed}. Crews, trains and holds come from here, through the same API and hold feed as any other system. All planning runs on this simulated time.</p>
      {message && <p className="card px-3 py-2 text-sm text-slate-700" role="status" data-testid="sim-message">{message}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card space-y-3 p-3" aria-label="Controls">
          <h2 className="panel-title">Clock</h2>
          <div className="num text-2xl font-semibold text-slate-900" data-testid="sim-clock">{sim.now ? `${clockDay(sim.now)}Z` : '–'}</div>
          <div className="text-sm text-slate-600">{sim.running ? `Running at ${sim.speed}× real time` : 'Paused'}</div>
          <div className="flex flex-wrap gap-2">
            {sim.running ? (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void act(() => api.simControl('pause'), () => 'Paused.')}><PauseIcon /> Pause</button>
            ) : (
              <button type="button" className="btn-primary" disabled={busy} onClick={() => void act(() => api.simControl('start', { speed: sim.speed }), () => 'Running.')}><PlayIcon /> Start</button>
            )}
            {[5, 15, 60].map((n) => (
              <button key={n} type="button" className="btn-secondary" disabled={busy} onClick={() => void act(() => api.simControl('step', { minutes: n, stepMin: n > 5 ? 5 : 1 }), () => `Stepped ${n} simulated minutes.`)}>+{n} min</button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label" htmlFor="speed">Speed factor</label>
              <input id="speed" className="input" type="number" min={1} max={3600} defaultValue={sim.speed} onBlur={(e) => void act(() => api.simControl('settings', { speed: Number(e.target.value) }), () => `Speed ${e.target.value}×.`)} />
            </div>
            <div>
              <label className="label" htmlFor="exc">Crew exception rate</label>
              <input id="exc" className="input" type="number" step={0.01} min={0} max={1} defaultValue={sim.exceptionRate} onBlur={(e) => void act(() => api.simControl('settings', { exceptionRate: Number(e.target.value) }), () => `Exception rate ${e.target.value}.`)} />
            </div>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="label" htmlFor="seed">Seed</label>
              <input id="seed" className="input" type="number" value={seed} placeholder={String(sim.seed)} onChange={(e) => setSeed(e.target.value)} />
            </div>
            <button type="button" className="btn-danger" disabled={busy} onClick={() => void act(() => api.simControl('reset', { seed: seedValue, exceptionRate: sim.exceptionRate }), () => `Yard reset from seed ${seedValue}.`)}><RefreshIcon /> Reset yard</button>
          </div>
        </section>
        <section className="card space-y-3 p-3" aria-label="Scenarios">
          <h2 className="panel-title">Make something go wrong</h2>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="label" htmlFor="late">Late train</label>
              <select id="late" className="input" value={lateTrain} onChange={(e) => setLateTrain(e.target.value)}>
                <option value="">Next to arrive</option>
                {pending.map((i) => <option key={i.id} value={i.id}>{i.id} {i.symbol}</option>)}
              </select>
            </div>
            <input aria-label="Minutes late" className="input w-20" type="number" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
            <button type="button" className="btn-secondary" disabled={busy} data-testid="scenario-late" onClick={() => void act(() => api.simScenario('late-train', { inboundId: lateTrain || undefined, minutes }), (r) => `${(r as { symbol: string }).symbol} is now ${minutes} min late.`)}>Make late</button>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="label" htmlFor="hold-car">Hold from railcar-health (blank picks a car)</label>
              <input id="hold-car" className="input" value={carId} onChange={(e) => setCarId(e.target.value)} placeholder="Car id" />
            </div>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void act(() => api.simScenario('hold', { carId: carId || undefined }), (r) => `Hold placed on ${(r as { carId: string }).carId}.`)}>Place hold</button>
            <button type="button" className="btn-ghost" disabled={busy || !carId} onClick={() => void act(() => api.simScenario('release', { carId }), () => `Hold on ${carId} released.`)}>Release</button>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="label" htmlFor="track">Block a track</label>
              <select id="track" className="input" value={trackId} onChange={(e) => setTrackId(e.target.value)}>
                {(board?.tracks ?? []).map((t) => <option key={t.id} value={t.id}>{t.id} {t.open ? '' : '(blocked)'}</option>)}
              </select>
            </div>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void act(() => api.simScenario('block-track', { trackId }), () => `${trackId} blocked.`)}>Block</button>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => void act(() => api.simScenario('unblock-track', { trackId }), () => `${trackId} reopened.`)}>Reopen</button>
          </div>
          <div className="flex items-center gap-2">
            <p className="flex-1 text-sm text-slate-600">Drop a crew report: the phone loses signal, and it syncs later, out of order. Waiting: {sim.delayedReports}.</p>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void act(() => api.simScenario('drop-report', { count: 2 }), () => 'The next two crew reports will sync late.')}>Drop reports</button>
          </div>
        </section>
      </div>
      <section className="card p-3" aria-label="Simulator log">
        <div className="flex items-center gap-2">
          <h2 className="panel-title">Recent events</h2>
          <span className="ml-auto font-mono text-xs text-slate-500" title="Two runs from the same seed produce the same digest">digest {sim.digest.slice(0, 12)} · scenario {sim.scenarioDigest.slice(0, 12)}</span>
        </div>
        <ol className="mt-2 max-h-72 space-y-0.5 overflow-y-auto font-mono text-xs text-slate-700">
          {sim.recent.map((line, i) => <li key={i}>{line}</li>)}
          {sim.recent.length === 0 && <li className="text-slate-500">Nothing yet. Press Start or step the clock.</li>}
        </ol>
      </section>
    </main>
  )
}
