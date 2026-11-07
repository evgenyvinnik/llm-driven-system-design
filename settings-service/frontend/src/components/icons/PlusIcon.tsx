import { Icon } from './Icon'
import type { IconProps } from './types'

export function PlusIcon(props: IconProps) {
  return <Icon {...props}><path d="M12 5v14M5 12h14" /></Icon>
}
