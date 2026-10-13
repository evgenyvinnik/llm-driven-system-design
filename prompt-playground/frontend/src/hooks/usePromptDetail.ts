import { useCallback, useEffect, useState } from 'react'
import { api } from '@/services/api'
import type { PromptDetail } from '@/types'

export function usePromptDetail(promptId: string) {
  const [detail, setDetail] = useState<PromptDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const data = await api.getPrompt(promptId)
      setDetail(data)
      setError(null)
      return data
    } catch (err) {
      setError((err as Error).message)
      return null
    }
  }, [promptId])

  useEffect(() => {
    setDetail(null)
    void reload()
  }, [reload])

  return { detail, error, reload }
}
