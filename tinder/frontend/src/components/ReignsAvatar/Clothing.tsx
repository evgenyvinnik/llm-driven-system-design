/**
 * @fileoverview Clothing and outfit rendering for the ReignsAvatar.
 * Includes shoulders, collar details, and decorative frame elements.
 */

import type { AvatarRenderContext } from './types';

/**
 * Props for clothing components.
 */
interface ClothingProps {
  /** Render context containing features and positioning */
  context: AvatarRenderContext;
}

/**
 * Renders the clothing/shoulders visible at the bottom of the avatar.
 * Features a medieval-style garment with collar detail.
 * Uses painterly filter for organic fabric appearance.
 *
 * @param props - Component props with render context
 * @returns SVG group element with shoulders and collar
 */
export function Clothing({ context }: ClothingProps) {
  const { features, seed, size, cx, cy, faceWidth, faceHeight } = context;

  return (
    <>
      {/* Shoulder garment base */}
      <path
        d={`M ${cx - faceWidth * 1.6} ${size}
            Q ${cx - faceWidth * 1.2} ${cy + faceHeight * 0.7}
              ${cx - faceWidth * 0.35} ${cy + faceHeight * 0.85}
            L ${cx + faceWidth * 0.35} ${cy + faceHeight * 0.85}
            Q ${cx + faceWidth * 1.2} ${cy + faceHeight * 0.7}
              ${cx + faceWidth * 1.6} ${size}
            Z`}
        fill={`url(#cloth-${seed})`}
        stroke={features.clothingPalette.secondary}
        strokeWidth="2"
        filter={`url(#paint-${seed})`}
      />
      {/* Collar accent detail */}
      <path
        d={`M ${cx - faceWidth * 0.35} ${cy + faceHeight * 0.85}
            Q ${cx} ${cy + faceHeight * 1.1}
              ${cx + faceWidth * 0.35} ${cy + faceHeight * 0.85}`}
        fill="none"
        stroke={features.clothingPalette.accent}
        strokeWidth="3"
      />
    </>
  );
}

/**
 * Renders the decorative frame border around the avatar.
 * Creates a portrait-style presentation inspired by classical paintings.
 *
 * @param props - Component props with render context
 * @returns SVG group element with outer and inner frame borders
 */
export function Frame({ context }: ClothingProps) {
  const { features, size } = context;

  return (
    <>
      {/* Outer solid frame border */}
      <rect
        x="8"
        y="8"
        width={size - 16}
        height={size - 16}
        fill="none"
        stroke={features.accessoryColor}
        strokeWidth="3"
        rx="4"
      />
      {/* Inner dashed decorative border */}
      <rect
        x="16"
        y="16"
        width={size - 32}
        height={size - 32}
        fill="none"
        stroke={features.accessoryColor}
        strokeWidth="1"
        strokeDasharray="8,4"
        opacity="0.5"
        rx="2"
      />
    </>
  );
}

/**
 * Renders the background with radial gradient.
 * Creates a subtle color wash that complements the clothing palette.
 *
 * @param props - Component props with render context
 * @returns SVG rect element with gradient background
 */
export function Background({ context }: ClothingProps) {
  const { seed, size } = context;

  return <rect width={size} height={size} fill={`url(#bg-${seed})`} />;
}
