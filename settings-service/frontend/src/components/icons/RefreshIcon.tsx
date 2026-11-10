import { Icon } from './Icon'
import type { IconProps } from './types'

export function RefreshIcon(props: IconProps) {
  return <Icon {...props}><path d="M20 11a8 8 0 0 0-14.8-4M4 13a8 8 0 0 0 14.8 4" /><path d="M20 4v7h-7M4 20v-7h7" /></Icon>
}
