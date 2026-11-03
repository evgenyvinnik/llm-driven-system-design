import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '@/services/api'
import { StaleOrgResponse } from './org-scope'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Kept for a quick switch back; the manifest still gates what renders.
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      // 401/403/404 are answers, not glitches; a dropped late response must stay dropped.
      retry: (count, err) =>
        !(err instanceof StaleOrgResponse) && !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
})
