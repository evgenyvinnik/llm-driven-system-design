import { useEffect } from 'react'
import { ColumnsIcon, PlayIcon, SpinnerIcon } from '@/components/icons'
import { ErrorNote } from '@/components/shared'
import { useCatalog } from '@/stores/catalog-store'
import { DEFAULT_CONFIG } from '@/stores/drafts-store'
import type { ModelConfig } from '@/types'
import { ConfigCard } from './ConfigCard'

interface Props {
  configs: ModelConfig[]
  onChange: (configs: ModelConfig[]) => void
  onRun: () => void
  launching: boolean
  blockedReason: string | null
  error: string | null
}

const LABELS = ['A', 'B', 'C']

export function ConfigPanel({ configs, onChange, onRun, launching, blockedReason, error }: Props) {
  const models = useCatalog((s) => s.models)
  const presets = useCatalog((s) => s.presets)
  const loadModels = useCatalog((s) => s.loadModels)
  const loadPresets = useCatalog((s) => s.loadPresets)

  useEffect(() => {
    void loadModels()
    void loadPresets()
  }, [loadModels, loadPresets])

  const comparing = configs.length > 1
  const update = (index: number, config: ModelConfig) => onChange(configs.map((c, i) => (i === index ? config : c)))

  return (
    <div className="flex flex-col gap-3">
      {configs.map((config, index) => (
        <ConfigCard
          key={index}
          config={config}
          label={comparing ? LABELS[index] : undefined}
          models={models}
          presets={presets}
          onChange={(c) => update(index, c)}
          onRemove={comparing ? () => onChange(configs.filter((_, i) => i !== index)) : undefined}
        />
      ))}
      {configs.length < 3 && (
        <button
          className="btn-secondary"
          onClick={() => onChange([...configs, { ...(configs[configs.length - 1] ?? DEFAULT_CONFIG), model: 'sim-quality' }])}
        >
          <ColumnsIcon /> {comparing ? 'Add another config' : 'Compare with another config'}
        </button>
      )}
      <button className="btn-primary py-2" onClick={onRun} disabled={launching || blockedReason !== null} title={blockedReason ?? 'Ctrl/Cmd + Enter'}>
        {launching ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : <PlayIcon />}
        {comparing ? `Run ${configs.length} side by side` : 'Run'}
        <kbd className="ml-1 rounded bg-white/20 px-1 text-[10px] font-normal">⌘↵</kbd>
      </button>
      {blockedReason && <p className="text-xs text-amber-700">{blockedReason}</p>}
      {error && <ErrorNote message={error} />}
    </div>
  )
}
