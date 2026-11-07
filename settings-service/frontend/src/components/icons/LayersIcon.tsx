import { Icon } from './Icon'
import type { IconProps } from './types'

export function LayersIcon(props: IconProps) {
  return <Icon {...props}><path d="m12 3 9 5-9 5-9-5 9-5z" /><path d="m3 13 9 5 9-5" /></Icon>
}
