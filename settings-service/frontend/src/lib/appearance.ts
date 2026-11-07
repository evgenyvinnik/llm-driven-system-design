/**
 * Applies the user's appearance settings to the whole app, live: theme,
 * density, text size, reduced motion. Uses the displayed value (pending edit
 * first), so a change shows instantly and also when it arrives from another device.
 * @module lib/appearance
 */
import { useEffect, useState } from 'react'
import { useAppSettings } from '@/stores/app-settings'
import { displayValue } from './display'

function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (e: MediaQueryListEvent) => setDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark
}

export function useApplyAppearance(): void {
  const theme = useAppSettings((s) => displayValue(s.doc?.settings['appearance.theme'], s.pending['appearance.theme']))
  const density = useAppSettings((s) => displayValue(s.doc?.settings['appearance.density'], s.pending['appearance.density']))
  const scale = useAppSettings((s) => displayValue(s.doc?.settings['appearance.font_scale'], s.pending['appearance.font_scale']))
  const reduce = useAppSettings((s) => displayValue(s.doc?.settings['appearance.reduce_motion'], s.pending['appearance.reduce_motion']))
  const systemDark = useSystemDark()

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark' || (theme === 'system' && systemDark))
    root.dataset.density = density === 'compact' ? 'compact' : 'comfortable'
    root.style.setProperty('--font-scale', typeof scale === 'number' ? `${scale}%` : '100%')
    root.classList.toggle('reduce-motion', reduce === true)
  }, [theme, density, scale, reduce, systemDark])
}
