import { Icon } from './Icon'
import type { IconProps } from './types'

export function PaletteIcon(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="12" r="9" /><circle cx="8" cy="10" r="1" /><circle cx="12" cy="7.5" r="1" /><circle cx="16" cy="10" r="1" /><path d="M12 21a2 2 0 0 1 0-4h1.5a2.5 2.5 0 0 0 0-5" /></Icon>
}
