import { createFileRoute } from '@tanstack/react-router'
import { Loading } from '@/components/shared/Loading'

// The root layout redirects "/" to the console (or the admin console for admins).
export const Route = createFileRoute('/')({ component: () => <Loading /> })
