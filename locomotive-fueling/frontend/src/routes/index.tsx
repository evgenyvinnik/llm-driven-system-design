import { createFileRoute } from '@tanstack/react-router'
import { Loading } from '@/components/shared/Loading'

// The root layout redirects "/" to the fleet board (or the crew's own train).
export const Route = createFileRoute('/')({ component: () => <Loading /> })
