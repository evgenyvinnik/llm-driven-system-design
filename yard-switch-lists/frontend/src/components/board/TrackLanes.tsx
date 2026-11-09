import { AlertIcon, LockIcon } from '@/components/icons'
import { blockColor } from '@/lib/blocks'
import type { TrackView } from '@/types'

const GROUPS: { kind: TrackView['kind']; label: string }[] = [
  { kind: 'receiving', label: 'Receiving' },
  { kind: 'classification', label: 'Classification' },
  { kind: 'departure', label: 'Departure' },
]

function Lane({ track, dropTarget, onBlockToggle }: { track: TrackView; dropTarget: boolean; onBlockToggle: (t: TrackView) => void }) {
  const over = track.occupiedFt > track.capacityFt
  const pct = Math.min(100, Math.round((track.occupiedFt / track.capacityFt) * 100))
  const blocks = Object.entries(track.blocks)
  return (
    <div data-track-id={track.id} data-testid={`lane-${track.id}`} className={`rounded-md border px-2 py-1 ${dropTarget ? 'border-accent-500 bg-accent-50' : 'border-slate-200 bg-white'} ${track.open ? '' : 'track-blocked'}`}>
      <div className="flex items-center gap-2 text-xs">
        <button type="button" className="w-8 font-mono font-semibold text-slate-900 hover:underline" title={track.open ? `Block ${track.name}` : `Reopen ${track.name}`} onClick={() => onBlockToggle(track)}>
          {track.id}
        </button>
        <span className="num text-slate-600">
          {track.occupiedFt.toLocaleString()} / {track.capacityFt.toLocaleString()} ft
        </span>
        {!track.open && (
          <span className="chip bg-rose-100 text-rose-900">
            <LockIcon className="h-3 w-3" /> blocked
          </span>
        )}
        {over && (
          <span className="chip bg-rose-100 text-rose-900">
            <AlertIcon className="h-3 w-3" /> over capacity
          </span>
        )}
        <span className="ml-auto truncate text-slate-500">{blocks.map(([b, n]) => `${b} ${n}`).join(' · ')}</span>
      </div>
      <div className="mt-1 flex h-4 items-stretch overflow-hidden rounded-sm bg-slate-100" role="img" aria-label={`${track.name}: ${track.carCount} cars, ${pct}% full`}>
        {track.cars.map((car) => (
          <div
            key={car.id}
            title={`${car.id} · ${car.blockId} · ${car.lengthFt} ft${car.hazmatClass ? ` · placard ${car.hazmatClass}` : ''}${car.held ? ' · ON HOLD' : ''}`}
            style={{ width: `${(car.lengthFt / track.capacityFt) * 100}%`, backgroundColor: blockColor(car.blockId) }}
            className={`mr-px flex items-center justify-center text-[9px] font-bold leading-none text-white last:mr-0 ${car.held ? 'outline outline-2 -outline-offset-2 outline-slate-900' : ''}`}
          >
            {car.held ? 'H' : car.hazmatClass ? '!' : ''}
          </div>
        ))}
      </div>
    </div>
  )
}

export function TrackLanes({ tracks, dropTrackId, onBlockToggle }: { tracks: TrackView[]; dropTrackId: string | null; onBlockToggle: (t: TrackView) => void }) {
  return (
    <section aria-label="Tracks" className="space-y-3">
      {GROUPS.map((g) => (
        <div key={g.kind}>
          <h2 className="panel-title mb-1">{g.label}</h2>
          <div className="space-y-1">
            {tracks
              .filter((t) => t.kind === g.kind)
              .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
              .map((t) => (
                <Lane key={t.id} track={t} dropTarget={dropTrackId === t.id} onBlockToggle={onBlockToggle} />
              ))}
          </div>
        </div>
      ))}
      <p className="text-xs text-slate-500">
        Occupancy is what crews reported, not what the plan says. <span className="font-semibold">H</span> is a car on hold, <span className="font-semibold">!</span> is a placarded car. Drag a move onto a lane to retarget it.
      </p>
    </section>
  )
}
