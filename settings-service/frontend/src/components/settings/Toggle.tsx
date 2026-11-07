interface ToggleProps {
  checked: boolean
  disabled?: boolean
  label: string
  name?: string
  onChange: (next: boolean) => void
}

export function Toggle({ checked, disabled, label, name, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      name={name}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 disabled:cursor-not-allowed disabled:opacity-60 ${
        checked ? 'bg-accent-600' : 'bg-faint/50'
      }`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  )
}
