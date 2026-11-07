import type { Role } from '@/types'

export function homeFor(role: Role): string {
  return role === 'shipper' ? '/cars' : '/exceptions'
}
