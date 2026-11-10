import { createFileRoute } from '@tanstack/react-router'
import { Loading } from '@/components/shared/Loading'

// The root route redirects "/" to /flags once the session check finishes.
export const Route = createFileRoute('/')({ component: () => <Loading /> })
