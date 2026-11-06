import { useRef, useState } from 'react'
import { ApiError, sendCommand, type Command, type CommandResult } from '@/services/api'

/**
 * Runs hazard commands with an idempotency key. The command id is created once
 * per submission and reused if the request fails with no response (network
 * error), so a retry can never act twice.
 */
export function useCommand(hazardId: string, seenVersion: number, onDone: (r: CommandResult) => void) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const pending = useRef<{ key: string; id: string } | null>(null)

  async function run(command: Command) {
    const key = JSON.stringify(command)
    if (!pending.current || pending.current.key !== key) pending.current = { key, id: crypto.randomUUID() }
    setBusy(command.kind)
    setError(null)
    setNotice(null)
    try {
      const result = await sendCommand(hazardId, command, seenVersion, pending.current.id)
      pending.current = null
      setNotice(result.replayed ? 'Already done (retried command returned the stored result).' : result.appended.length ? `Recorded: ${result.appended.join(', ')}` : 'Nothing to change.')
      onDone(result)
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) setError('No response from the server. Retry is safe: the same command id is reused.')
      else {
        pending.current = null
        setError(err instanceof Error ? err.message : 'Command failed')
      }
    } finally {
      setBusy(null)
    }
  }
  return { run, busy, error, notice }
}
