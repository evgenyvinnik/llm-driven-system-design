import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'

/** Opens an in-app href like "/mail?m=m_off1" through the router. */
export function useOpenHref() {
  const navigate = useNavigate()
  return useCallback(
    (href: string) => {
      const url = new URL(href, window.location.origin)
      void navigate({ to: url.pathname, search: Object.fromEntries(url.searchParams) as never })
    },
    [navigate],
  )
}
