import { Link } from '@tanstack/react-router'
import { dateTimeText } from '@/lib/format'
import type { CarDetail } from '@/types'

export function CarTrips({ trips }: { trips: CarDetail['trips'] }) {
  return (
    <table className="w-full">
      <thead className="border-b border-slate-100">
        <tr><th className="th">Trip</th><th className="th">Departed</th><th className="th">Position</th><th className="th">Leading end</th><th className="th">Known from</th></tr>
      </thead>
      <tbody className="divide-y divide-slate-50">
        {trips.map((t) => (
          <tr key={t.tripId}>
            <td className="td">
              {t.tripId.startsWith('HIST') || t.tripId.endsWith('-H1') || t.tripId.endsWith('-H2') ? (
                <span className="font-mono">{t.symbol}</span>
              ) : (
                <Link to="/trains/$tripId" params={{ tripId: t.tripId }} className="font-mono text-accent-700 hover:underline">{t.symbol}</Link>
              )}{' '}
              <span className="text-xs text-slate-500">{t.direction}</span>
            </td>
            <td className="td">{dateTimeText(t.departedAt)}</td>
            <td className="td">{t.position}</td>
            <td className="td">{t.leadingEnd}-end</td>
            <td className="td text-xs">{t.orientationSource === 'aei' ? <span className="chip bg-sky-50 text-sky-800 ring-1 ring-sky-200">AEI at {t.correctedByDetector} (consist was stale)</span> : 'consist'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
