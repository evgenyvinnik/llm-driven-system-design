export const SIZE_UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 } as const
export type SizeUnit = keyof typeof SIZE_UNITS

/** "2.5" + "MB" → 2621440, or null if the amount isn't a non-negative number. */
export function toBytes(amount: string, unit: SizeUnit): number | null {
  const value = Number(amount)
  if (amount.trim() === '' || !Number.isFinite(value) || value < 0) return null
  return Math.round(value * SIZE_UNITS[unit])
}
