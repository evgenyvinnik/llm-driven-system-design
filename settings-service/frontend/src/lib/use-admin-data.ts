/**
 * Loads data for an admin page and reloads it whenever this tab's settings
 * client sees the org policy or catalog revision move (the SSE stream that the
 * whole app already holds), so two admins see each other's changes live.
 * @module lib/use-admin-data
 */
import { useCallback, useEffect, useState } from 'react'
import { useAppSettings } from '@/stores/app-settings'

export function useAdminData<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const orgRevision = useAppSettings((s) => s.doc?.orgRevision)
  const catalogRevision = useAppSettings((s) => s.doc?.catalogRevision)

  const reload = useCallback(async () => {
    try {
      setData(await load())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    }
  }, [load])

  useEffect(() => {
    void reload()
  }, [reload, orgRevision, catalogRevision])

  return { data, error, reload }
}
