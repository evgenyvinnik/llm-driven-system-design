/**
 * The key question, answered with this experiment's own numbers: units that
 * were assigned but never rendered the variant are not exposed. Analyzing
 * everyone assigned mixes them in, and since the change could not have
 * affected them, the measured effect shrinks toward zero.
 */
import { EyeIcon } from '@/components/icons'
import { num, pct, signedPct } from '@/lib/format'
import type { Analysis } from '@/types'

export function AssignedVsExposed({ assigned, exposed, surface }: { assigned: Analysis; exposed: Analysis; surface: string }) {
  const rows = exposed.arms.map((x) => {
    const a = assigned.arms.find((y) => y.variant === x.variant)
    return { variant: x.variant, assigned: a?.units ?? 0, exposed: x.units, assignedLift: a?.lift ?? null, exposedLift: x.lift }
  })
  const totalAssigned = assigned.totalUnits
  const share = totalAssigned > 0 ? exposed.totalUnits / totalAssigned : 0
  return (
    <section className="card space-y-3 p-4" aria-label="Assigned versus exposed">
      <div className="flex items-center gap-2">
        <EyeIcon className="h-4 w-4 text-accent-600" />
        <h2 className="panel-title">Assigned vs exposed</h2>
      </div>
      <p className="text-sm text-slate-600">
        {num(totalAssigned)} units were assigned a variant; {num(exposed.totalUnits)} ({pct(share, 0)}) actually rendered it on <span className="font-medium">{surface || 'its surface'}</span>. The other{' '}
        {num(Math.max(0, totalAssigned - exposed.totalUnits))} never saw either version, so they are not exposures and stay out of the analysis.
      </p>
      <table className="w-full text-sm" aria-label="Assignment and exposure by variant">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <th className="py-1 font-medium">Variant</th>
            <th className="py-1 text-right font-medium">Assigned</th>
            <th className="py-1 text-right font-medium">Exposed</th>
            <th className="py-1 text-right font-medium">Exposure rate</th>
            <th className="py-1 text-right font-medium">Lift, all assigned</th>
            <th className="py-1 text-right font-medium">Lift, exposed only</th>
          </tr>
        </thead>
        <tbody className="num divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.variant}>
              <td className="py-1.5">
                <code className="code">{r.variant}</code>
              </td>
              <td className="text-right">{num(r.assigned)}</td>
              <td className="text-right">{num(r.exposed)}</td>
              <td className="text-right">{r.assigned > 0 ? pct(r.exposed / r.assigned, 1) : '—'}</td>
              <td className="text-right text-slate-500">{r.assignedLift ? signedPct(r.assignedLift.relLift) : '—'}</td>
              <td className="text-right font-semibold">{r.exposedLift ? signedPct(r.exposedLift.relLift) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-slate-500">
        Analyzing everyone assigned (intent-to-treat on assignment) adds units the change could not have affected: their conversions are the same in both arms, so they add noise and pull the
        relative lift toward zero. Exposure is logged by the SDK only when the variant mounts (or scrolls into view), once per unit per config version; forced and excluded units never log.
      </p>
    </section>
  )
}
