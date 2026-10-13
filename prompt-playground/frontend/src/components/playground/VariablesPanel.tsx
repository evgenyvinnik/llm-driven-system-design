interface Props {
  names: string[]
  values: Record<string, string>
  missing: string[]
  onChange: (values: Record<string, string>) => void
}

/** One input per {{variable}} found in the prompt. Values are per run, not part of the version. */
export function VariablesPanel({ names, values, missing, onChange }: Props) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="panel-title">Variables</span>
        {missing.length > 0 && <span className="text-xs text-amber-700">{missing.length} to fill in</span>}
      </div>
      {names.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-500">
          Add <span className="font-mono">{'{{name}}'}</span> to the prompt to create inputs.
        </p>
      ) : (
        <div className="space-y-2">
          {names.map((name) => (
            <div key={name}>
              <label className="mb-0.5 block font-mono text-xs text-slate-600" htmlFor={`var-${name}`}>
                {name}
              </label>
              <textarea
                id={`var-${name}`}
                rows={name.length > 0 && (values[name] ?? '').length > 80 ? 3 : 1}
                className={`input resize-y font-mono text-xs ${missing.includes(name) ? 'border-amber-300 bg-amber-50/40' : ''}`}
                value={values[name] ?? ''}
                onChange={(e) => onChange({ ...values, [name]: e.target.value })}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
