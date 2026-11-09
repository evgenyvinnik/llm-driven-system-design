import { createFileRoute } from '@tanstack/react-router'
import { Loading } from '@/components/shared/Loading'

// The root redirects from here once it knows who is signed in.
export const Route = createFileRoute('/')({ component: () => <Loading /> })
