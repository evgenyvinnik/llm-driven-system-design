import { Icon } from './Icon'
import type { IconProps } from './types'

export function AlertIcon(props: IconProps) {
  return <Icon {...props}><path d="M12 3 2 20h20L12 3z" /><path d="M12 10v4M12 17h.01" /></Icon>
}
