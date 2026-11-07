import { createFileRoute } from '@tanstack/react-router'
import { Loading } from '@/components/shared/Loading'

// The root layout redirects "/" to /settings (or /login) once auth is known.
export const Route = createFileRoute('/')({
  component: () => (
    <main>
      <Loading />
    </main>
  ),
})
