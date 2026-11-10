import { createFileRoute } from '@tanstack/react-router'
import { Loading } from '@/components/shared/Loading'

// The root layout redirects "/" to the library (members) or operations (operators).
export const Route = createFileRoute('/')({ component: () => <Loading /> })
