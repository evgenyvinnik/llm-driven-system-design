import { Icon } from './Icon'
import type { IconProps } from './types'

export function UserIcon(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Icon>
}
