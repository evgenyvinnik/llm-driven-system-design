import { createFileRoute } from '@tanstack/react-router'
import { Loading } from '@/components/shared/Feedback'

// The root route sends `/` on to /repos or /login once the session check is back.
export const Route = createFileRoute('/')({ component: () => <Loading /> })
