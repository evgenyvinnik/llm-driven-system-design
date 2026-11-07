import type { Flag } from '@/types'

const UNIT_HELP: Record<string, string> = {
  user: 'Bucketed by stable id: the anonymous id until sign-in, then the identity alias (the first anonymous id that user signed in from). Visitors keep their variant when they sign in.',
  org: 'Bucketed by organization id: everyone in an org sees the same variant. Signed-out visitors are not enrolled.',
  anonymous: 'Bucketed by the device’s anonymous id. Does not change at sign-in; not stable across devices.',
}

export function FlagDetails({ flag }: { flag: Flag }) {
  return (
    <section className="card space-y-3 p-4 text-sm" aria-label="Details">
      <h2 className="panel-title">Definition</h2>
      <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2">
        <dt className="text-slate-500">Assignment unit</dt>
        <dd>
          <span className="chip bg-slate-100 text-slate-700">{flag.unitType}</span>
          <p className="mt-1 text-xs text-slate-500">{UNIT_HELP[flag.unitType]}</p>
        </dd>
        <dt className="text-slate-500">Salt</dt>
        <dd>
          <code className="code">{flag.salt}</code>
          <p className="mt-1 text-xs text-slate-500">bucket = murmur3(salt + "." + unit id) mod 10,000. Generated at creation and never changed: a new salt would re-randomize everyone, so a rerun is a new experiment.</p>
        </dd>
        <dt className="text-slate-500">Variants</dt>
        <dd className="space-y-1.5">
          {flag.variants.map((v) => (
            <div key={v.key}>
              <div className="flex flex-wrap items-center gap-1.5">
                <code className="code">{v.key}</code>
                {v.key === flag.defaultVariant && <span className="chip bg-slate-100 text-slate-500">default</span>}
              </div>
              <div className="text-xs text-slate-600">
                {v.name}
                {v.value !== undefined && <span className="ml-1 font-mono text-slate-400">= {JSON.stringify(v.value)}</span>}
              </div>
            </div>
          ))}
        </dd>
        {flag.kind === 'experiment' && (
          <>
            <dt className="text-slate-500">Primary metric</dt>
            <dd>
              <code className="code">{flag.primaryMetric}</code> within {flag.attributionWindowHours} h after a unit’s first exposure
            </dd>
          </>
        )}
        <dt className="text-slate-500">Renders on</dt>
        <dd>{flag.surface || '—'}</dd>
      </dl>
    </section>
  )
}
