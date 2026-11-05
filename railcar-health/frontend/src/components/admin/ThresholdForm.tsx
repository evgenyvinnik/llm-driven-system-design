/**
 * Threshold editor with a backtest. Values are illustrative tuning knobs for
 * the simulation, not regulatory or industry limits.
 */
import { useState } from 'react'
import { api, ApiError } from '@/services/api'
import type { Backtest, Thresholds } from '@/types'
import { BacktestResult } from './BacktestResult'

const GROUPS: Array<{ title: string; fields: Array<[string, string]> }> = [
  { title: 'Absolute (°F above ambient)', fields: [['criticalAboveAmbient', 'CRITICAL, mirrors the detector alarm'], ['highAboveAmbient', 'HIGH']] },
  { title: 'Relative to train-side median (°F)', fields: [['highSideDelta', 'HIGH level (with rise)'], ['mediumSideDelta', 'MEDIUM level (2+ detectors)'], ['mediumOutlierSideDelta', 'MEDIUM single outlier'], ['elevatedSideDelta', 'Elevated / LOW']] },
  { title: 'Trend (°F per 15 mi)', fields: [['highRisePer15mi', 'HIGH rise'], ['mediumRisePer15mi', 'MEDIUM rise'], ['mediumRiseMinSideDelta', 'MEDIUM rise needs at least (°F)']] },
  { title: 'History, wheels, detectors', fields: [['lowHistoryTrips', 'LOW: elevated on N prior trips'], ['hotWheelDelta', 'Hot wheel MEDIUM (°F)'], ['hotWheelHighDelta', 'Hot wheel HIGH (°F)'], ['maxDetectorSpacingMiles', 'Coverage gap over (mi)'], ['biasAlarmF', 'Detector bias flag (°F)']] },
]

export function ThresholdForm({ initial, version, onSaved }: { initial: Thresholds; version: number; onSaved: () => void }) {
  const [values, setValues] = useState<Thresholds>(initial)
  const [preview, setPreview] = useState<Backtest | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const changed = Object.keys(values).some((k) => values[k] !== initial[k])

  async function run(kind: 'preview' | 'save') {
    setBusy(true)
    setMessage(null)
    try {
      if (kind === 'preview') setPreview(await api.previewThresholds(values))
      else {
        const res = await api.saveThresholds(version, values)
        setMessage(`Saved as version ${res.version}. The analyzer applies it to the next pass it scores.`)
        onSaved()
      }
    } catch (err) {
      setMessage(err instanceof ApiError && err.code === 'STALE_VERSION' ? 'Someone else changed the thresholds. Reload to see their version.' : (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">Illustrative values for this simulation. Real alarm limits are set per railroad, detector type and route; none of these are regulatory numbers.</p>
      <div className="grid grid-cols-2 gap-4">
        {GROUPS.map((g) => (
          <fieldset key={g.title} className="rounded-md border border-slate-200 p-3">
            <legend className="px-1 text-xs font-semibold text-slate-600">{g.title}</legend>
            <div className="space-y-2">
              {g.fields.map(([key, label]) => (
                <label key={key} className="flex items-center justify-between gap-3 text-sm text-slate-700">
                  <span>{label}</span>
                  <input type="number" name={key} className="input w-24 text-right" value={values[key] ?? ''} step="1"
                    onChange={(e) => setValues({ ...values, [key]: Number(e.target.value) })} />
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void run('preview')}>Backtest against findings</button>
        <button type="button" className="btn-primary" disabled={busy || !changed} onClick={() => void run('save')}>Save thresholds</button>
        {changed && <button type="button" className="btn-ghost" onClick={() => setValues(initial)}>Reset</button>}
        {message && <span className="text-sm text-slate-600">{message}</span>}
      </div>
      {preview && <BacktestResult result={preview} />}
    </div>
  )
}
