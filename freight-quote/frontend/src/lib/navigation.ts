import type { Role } from '@/types'

export const homeFor = (role: Role): string => (role === 'customer' ? '/' : '/ops')
