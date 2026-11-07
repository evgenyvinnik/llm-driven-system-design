import { Icon } from './Icon'
import type { IconProps } from './types'

export function ClockIcon(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>
}
