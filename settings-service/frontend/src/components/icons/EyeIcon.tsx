import { Icon } from './Icon'
import type { IconProps } from './types'

export function EyeIcon(props: IconProps) {
  return <Icon {...props}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></Icon>
}
