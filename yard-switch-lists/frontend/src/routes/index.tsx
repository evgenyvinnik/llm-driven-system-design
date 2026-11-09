import { createFileRoute } from '@tanstack/react-router'
import { Loading } from '@/components/shared/Loading'

// The root layout redirects "/" to the board, or to the handheld for a crew member.
export const Route = createFileRoute('/')({ component: () => <Loading /> })
