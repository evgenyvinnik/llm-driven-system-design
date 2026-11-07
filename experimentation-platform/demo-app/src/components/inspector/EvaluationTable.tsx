import type { ExperimentClient } from 'experimentation-sdk'
import { useClientState } from 'experimentation-sdk/react'
import { DEFAULTS } from '@/lib/experiments'

/** Every known flag for the current context: variant, why, bucket, and whether this unit was exposed. */
export function EvaluationTable({ client }: { client: ExperimentClient }) {
  useClientState() // re-render on every snapshot, context or exposure change
  const keys = [...new Set([...Object.keys(client.getSnapshot()?.flags ?? {}), ...Object.keys(DEFAULTS)])].sort()
  return (
    <table className="mt-3 w-full" aria-label="Evaluations">
      <thead>
        <tr className="text-left text-stone-400">
          <th className="py-1 font-medium">flag</th>
          <th className="py-1 font-medium">variant</th>
          <th className="py-1 font-medium">reason</th>
          <th className="py-1 text-right font-medium">bucket</th>
          <th className="py-1 text-right font-medium">exposed</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-stone-800 font-mono">
        {keys.map((key) => {
          const e = client.peek(key)
          const exposed = e.inExperiment && client.hasExposed(e)
          return (
            <tr key={key} data-eval={key}>
              <td className="py-1 pr-2">{key}</td>
              <td className={`pr-2 ${e.reason === 'allocated' || e.reason === 'forced' ? 'text-amber-300' : 'text-stone-300'}`}>{e.variant ?? '—'}</td>
              <td className="pr-2 text-stone-400">{e.reason}</td>
              <td className="pr-2 text-right text-stone-400">{e.bucket ?? '—'}</td>
              <td className="text-right">{e.inExperiment ? (exposed ? <span className="text-emerald-300">yes</span> : <span className="whitespace-nowrap text-stone-500">no (assigned)</span>) : <span className="text-stone-600">n/a</span>}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
