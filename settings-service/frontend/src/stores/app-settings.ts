/**
 * The settings client for this browser tab (the "given" preferences screen,
 * the app's own appearance). Shares results with other tabs over BroadcastChannel.
 */
import { useStore } from 'zustand'
import { createSettingsStore, type SettingsActions, type SettingsState } from '@/lib/settings-store'
import { newClientId } from '@/lib/display'
import { api } from '@/services/api'

export const appSettings = createSettingsStore({
  api,
  apiBase: '/api',
  identity: { clientId: newClientId('tab'), clientLabel: 'Web browser' },
  broadcast: true,
})

export function useAppSettings<T>(selector: (s: SettingsState & SettingsActions) => T): T {
  return useStore(appSettings, selector)
}
