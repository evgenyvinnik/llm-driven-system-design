import { createFileRoute } from '@tanstack/react-router'
import { Loading } from '@/components/shared/Loading'

// The root layout redirects "/" to the signed-in user's home page.
export const Route = createFileRoute('/')({ component: () => <Loading /> })
