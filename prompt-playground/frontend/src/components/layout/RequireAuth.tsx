import type { ReactNode } from 'react'
import { Navigate } from '@tanstack/react-router'
import { Loading } from '@/components/shared'
import { useAuth } from '@/stores/auth-store'

export function RequireAuth({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const status = useAuth((s) => s.status)
  const user = useAuth((s) => s.user)
  if (status === 'loading') return <Loading />
  if (status === 'anonymous') return <Navigate to="/login" />
  if (admin && user?.role !== 'admin') {
    return <p className="p-8 text-sm text-slate-600">The admin dashboard is only available to admins.</p>
  }
  return <>{children}</>
}
