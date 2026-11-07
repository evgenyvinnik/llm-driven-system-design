import { useEnvStore } from '@/stores/env-store'

const ENVS = [
  { key: 'prod', label: 'Production' },
  { key: 'dev', label: 'Development' },
]

export function EnvSwitcher() {
  const env = useEnvStore((s) => s.env)
  const setEnv = useEnvStore((s) => s.setEnv)
  return (
    <div className="rounded-md bg-slate-800 p-0.5" role="radiogroup" aria-label="Environment">
      {ENVS.map((e) => (
        <button
          key={e.key}
          type="button"
          role="radio"
          aria-checked={env === e.key}
          onClick={() => setEnv(e.key)}
          className={`w-1/2 rounded px-2 py-1 text-xs font-medium ${env === e.key ? (e.key === 'prod' ? 'bg-amber-400 text-slate-900' : 'bg-sky-400 text-slate-900') : 'text-slate-300 hover:text-white'}`}
        >
          {e.label}
        </button>
      ))}
    </div>
  )
}
