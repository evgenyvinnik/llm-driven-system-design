import { Icon, type IconProps } from './Icon'

export type { IconProps }

export const LogoIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 18V6l6 5 6-5v12" />
  </Icon>
)
export const TerminalIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 17l6-5-6-5M12 19h8" />
  </Icon>
)
export const GaugeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 14l4-4M3.5 18a9 9 0 1117 0" />
  </Icon>
)
export const RouteIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="5" r="2" />
    <path d="M8 19h7a3 3 0 000-6H9a3 3 0 010-6h7" />
  </Icon>
)
export const LogoutIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l5-5-5-5M15 12H3" />
  </Icon>
)
export const PlayIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 5l12 7-12 7V5z" />
  </Icon>
)
export const StopIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Icon>
)
export const UnplugIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 01-10 0V7zM12 16v5" />
  </Icon>
)
export const ServerIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="4" width="16" height="7" rx="1.5" />
    <rect x="4" y="13" width="16" height="7" rx="1.5" />
    <path d="M8 7.5h.01M8 16.5h.01" />
  </Icon>
)
export const BoltIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 3L5 14h6l-1 7 8-11h-6l1-7z" />
  </Icon>
)
export const KeyIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9M17 6l2 2M15 8l2 2" />
  </Icon>
)
export const ArrowLeftIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Icon>
)
