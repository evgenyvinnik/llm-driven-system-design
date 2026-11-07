import { Icon } from './Icon'
import type { IconProps } from './types'

export function ServerIcon(props: IconProps) {
  return <Icon {...props}><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /><path d="M7 7.5h.01M7 16.5h.01" /></Icon>
}
