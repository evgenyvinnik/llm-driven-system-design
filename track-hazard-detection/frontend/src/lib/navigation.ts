import type { Role } from '@/types'

export function homeFor(role: Role | undefined): string {
  if (role === 'admin') return '/board'
  if (role === 'inspector') return '/alerts'
  return '/board'
}
