import { createFileRoute } from '@tanstack/react-router'
import { Loading } from '@/components/shared/Loading'

// The root layout redirects "/" to the endpoints list (customers) or operations (operators).
export const Route = createFileRoute('/')({ component: () => <Loading /> })
