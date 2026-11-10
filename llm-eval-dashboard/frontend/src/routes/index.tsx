import { createFileRoute } from '@tanstack/react-router'
import { Loading } from '@/components/shared/Loading'

// The root layout redirects "/" to the runs list.
export const Route = createFileRoute('/')({ component: () => <Loading /> })
