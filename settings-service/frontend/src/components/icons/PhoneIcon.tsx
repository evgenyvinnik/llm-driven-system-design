import { Icon } from './Icon'
import type { IconProps } from './types'

export function PhoneIcon(props: IconProps) {
  return <Icon {...props}><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></Icon>
}
