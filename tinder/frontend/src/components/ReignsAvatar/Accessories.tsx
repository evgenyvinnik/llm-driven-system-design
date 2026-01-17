/**
 * @fileoverview Accessory rendering components for the ReignsAvatar.
 * Includes crown, earrings, and necklace with metallic effects.
 */

import type { AvatarRenderContext } from './types';

/**
 * Props for accessory components.
 */
interface AccessoryProps {
  /** Render context containing features and positioning */
  context: AvatarRenderContext;
}

/**
 * Renders a royal crown with jewels when enabled.
 * Features a classic pointed crown design with gem accents.
 *
 * @param props - Component props with render context
 * @returns SVG group element with crown and jewels, or null if not enabled
 */
export function Crown({ context }: AccessoryProps) {
  const { features, seed, cx, cy, faceWidth, faceHeight } = context;

  if (!features.hasCrown) {
    return null;
  }

  return (
    <g filter={`url(#shadow-${seed})`}>
      {/* Crown base with pointed peaks */}
      <path
        d={`M ${cx - faceWidth * 0.6} ${cy - faceHeight * 0.45}
            L ${cx - faceWidth * 0.5} ${cy - faceHeight * 0.7}
            L ${cx - faceWidth * 0.3} ${cy - faceHeight * 0.55}
            L ${cx - faceWidth * 0.15} ${cy - faceHeight * 0.8}
            L ${cx} ${cy - faceHeight * 0.6}
            L ${cx + faceWidth * 0.15} ${cy - faceHeight * 0.8}
            L ${cx + faceWidth * 0.3} ${cy - faceHeight * 0.55}
            L ${cx + faceWidth * 0.5} ${cy - faceHeight * 0.7}
            L ${cx + faceWidth * 0.6} ${cy - faceHeight * 0.45}
            Z`}
        fill={`url(#metal-${seed})`}
        stroke={features.accessoryColor}
        strokeWidth="2"
      />
      {/* Crown jewels - center ruby */}
      <circle cx={cx} cy={cy - faceHeight * 0.72} r="5" fill="#E74C3C" />
      {/* Crown jewels - left sapphire */}
      <circle cx={cx - faceWidth * 0.35} cy={cy - faceHeight * 0.58} r="4" fill="#3498DB" />
      {/* Crown jewels - right emerald */}
      <circle cx={cx + faceWidth * 0.35} cy={cy - faceHeight * 0.58} r="4" fill="#27AE60" />
    </g>
  );
}

/**
 * Renders decorative earrings for feminine avatars when enabled.
 * Features circular metallic drops with ruby accents.
 *
 * @param props - Component props with render context
 * @returns SVG fragment with earrings, or null if not enabled
 */
export function Earrings({ context }: AccessoryProps) {
  const { features, seed, cx, cy, faceWidth, faceHeight } = context;

  if (!features.hasEarrings) {
    return null;
  }

  return (
    <>
      {/* Left earring */}
      <circle
        cx={cx - faceWidth * 0.48}
        cy={cy + faceHeight * 0.05}
        r="6"
        fill={`url(#metal-${seed})`}
        stroke={features.accessoryColor}
        strokeWidth="1"
      />
      <circle cx={cx - faceWidth * 0.48} cy={cy + faceHeight * 0.12} r="4" fill="#E74C3C" />

      {/* Right earring */}
      <circle
        cx={cx + faceWidth * 0.48}
        cy={cy + faceHeight * 0.05}
        r="6"
        fill={`url(#metal-${seed})`}
        stroke={features.accessoryColor}
        strokeWidth="1"
      />
      <circle cx={cx + faceWidth * 0.48} cy={cy + faceHeight * 0.12} r="4" fill="#E74C3C" />
    </>
  );
}

/**
 * Renders a pendant necklace when enabled.
 * Features a curved chain with a central gem pendant.
 *
 * @param props - Component props with render context
 * @returns SVG group element with necklace, or null if not enabled
 */
export function Necklace({ context }: AccessoryProps) {
  const { features, seed, cx, cy, faceWidth, faceHeight } = context;

  if (!features.hasNecklace) {
    return null;
  }

  return (
    <g>
      {/* Necklace chain */}
      <path
        d={`M ${cx - faceWidth * 0.3} ${cy + faceHeight * 0.55}
            Q ${cx} ${cy + faceHeight * 0.75}
              ${cx + faceWidth * 0.3} ${cy + faceHeight * 0.55}`}
        fill="none"
        stroke={features.accessoryColor}
        strokeWidth="3"
      />
      {/* Pendant setting */}
      <circle
        cx={cx}
        cy={cy + faceHeight * 0.72}
        r="8"
        fill={`url(#metal-${seed})`}
        stroke={features.accessoryColor}
        strokeWidth="1"
      />
      {/* Pendant gem - amethyst */}
      <circle cx={cx} cy={cy + faceHeight * 0.72} r="4" fill="#9B59B6" />
    </g>
  );
}
