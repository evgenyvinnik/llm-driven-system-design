import { createFileRoute } from '@tanstack/react-router'
import { Loading } from '@/components/shared/Loading'

// The root layout redirects "/" to the user's home page once the session is known.
export const Route = createFileRoute('/')({ component: () => <Loading /> })
