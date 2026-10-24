/**
 * Loads one directory's listing and the largest files below it. `reload` runs
 * after every write, so totals and the largest list always reflect the server.
 *
 * Directories are implicit, so one can vanish while it's on screen (its last
 * file was deleted, here or elsewhere). `vanished` says that happened, as
 * opposed to opening a path that never existed.
 *
 * Every result is stored with the path it belongs to, so nothing about the
 * previous directory leaks into the next one while its request is in flight.
 */
import { useCallback, useEffect, useState } from 'react'
import { parentPath } from '@/lib/paths'
import { api, ApiError, errorMessage } from '@/services/api'
import type { DirListing, LargestFile } from '@/types'

interface DirectoryState {
  path: string
  listing: DirListing | null
  largest: LargestFile[]
  error: { code: string; message: string } | null
  vanished: boolean
}

export function useDirectory(path: string) {
  const [state, setState] = useState<DirectoryState | null>(null)

  const reload = useCallback(async () => {
    try {
      const prefix = path === '/' ? '/' : `${path}/`
      const [listing, top] = await Promise.all([api.list(path), api.largest(prefix, 8)])
      setState({ path, listing, largest: top.files, error: null, vanished: false })
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'ERROR'
      setState((previous) => ({
        path,
        listing: null,
        largest: [],
        error: { code, message: errorMessage(err) },
        // It vanished if this same path had a listing a moment ago.
        vanished: code === 'NOT_A_DIRECTORY' && previous?.path === path && (previous.listing !== null || previous.vanished),
      }))
    }
  }, [path])

  useEffect(() => {
    void reload()
  }, [reload])

  const current = state?.path === path ? state : null
  return {
    listing: current?.listing ?? null,
    largest: current?.largest ?? [],
    error: current?.error ?? null,
    vanished: current?.vanished ?? false,
    reload,
  }
}

/** The closest ancestor of `path` that is still a directory. The root always is. */
export function useNearestDirectory(path: string, enabled: boolean): string | null {
  const [found, setFound] = useState<{ path: string; nearest: string } | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void (async () => {
      let candidate = parentPath(path)
      while (candidate !== '/') {
        try {
          await api.list(candidate)
          break
        } catch {
          candidate = parentPath(candidate)
        }
      }
      if (!cancelled) setFound({ path, nearest: candidate })
    })()
    return () => {
      cancelled = true
    }
  }, [path, enabled])

  return enabled && found?.path === path ? found.nearest : null
}
