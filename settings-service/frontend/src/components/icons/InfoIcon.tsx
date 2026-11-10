import { Icon } from './Icon'
import type { IconProps } from './types'

export function InfoIcon(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></Icon>
}
