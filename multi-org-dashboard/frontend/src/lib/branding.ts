/**
 * Per-org branding without fragile UI: an org picks an accent from a fixed
 * palette whose shades were chosen for contrast with white text, plus
 * initials for its badge. The layout, fonts and spacing never change per org.
 */
import type { CSSProperties } from 'react'

type Shades = Record<'50' | '100' | '500' | '600' | '700', string>

const PALETTE: Record<string, Shades> = {
  indigo: { 50: '238 242 255', 100: '224 231 255', 500: '99 102 241', 600: '79 70 229', 700: '67 56 202' },
  teal: { 50: '240 253 250', 100: '204 251 241', 500: '20 184 166', 600: '13 148 136', 700: '15 118 110' },
  violet: { 50: '245 243 255', 100: '237 233 254', 500: '139 92 246', 600: '124 58 237', 700: '109 40 217' },
  rose: { 50: '255 241 242', 100: '255 228 230', 500: '244 63 94', 600: '225 29 72', 700: '190 18 60' },
  amber: { 50: '255 251 235', 100: '254 243 199', 500: '245 158 11', 600: '180 83 9', 700: '146 64 14' },
}

export function brandStyle(accent: string | undefined): CSSProperties {
  const shades = PALETTE[accent ?? ''] ?? PALETTE.indigo
  return Object.fromEntries(Object.entries(shades).map(([k, v]) => [`--brand-${k}`, v])) as CSSProperties
}

export function brandSwatch(accent: string | undefined): string {
  const shades = PALETTE[accent ?? ''] ?? PALETTE.indigo
  return `rgb(${shades[600]})`
}
