/**
 * @fileoverview Face and neck rendering components for the ReignsAvatar.
 * Handles the core facial structure including face shape, cheekbones, and neck.
 */

import type { AvatarRenderContext } from './types';
import { getFaceShape } from './utils';

/**
 * Props for face rendering components.
 */
interface FaceProps {
  /** Render context containing features and positioning */
  context: AvatarRenderContext;
}

/**
 * Renders the neck element that connects face to clothing.
 * Positioned behind the face layer to create proper depth.
 *
 * @param props - Component props with render context
 * @returns SVG path element for the neck
 */
export function Neck({ context }: FaceProps) {
  const { features, seed, cx, cy, faceWidth, faceHeight } = context;

  return (
    <path
      d={`M ${cx - faceWidth * 0.25} ${cy + faceHeight * 0.4}
          L ${cx - faceWidth * 0.35} ${cy + faceHeight * 0.9}
          L ${cx + faceWidth * 0.35} ${cy + faceHeight * 0.9}
          L ${cx + faceWidth * 0.25} ${cy + faceHeight * 0.4}`}
      fill={`url(#skin-${seed})`}
      stroke={features.skinPalette.shadow}
      strokeWidth="1.5"
    />
  );
}

/**
 * Renders the main face shape with painterly texture effect.
 * The face shape varies based on the avatar's faceShape feature.
 *
 * @param props - Component props with render context
 * @returns SVG path element for the face outline
 */
export function FaceShape({ context }: FaceProps) {
  const { features, seed, cx, cy, faceWidth, faceHeight } = context;

  return (
    <path
      d={getFaceShape(features.faceShape, cx, cy, faceWidth, faceHeight)}
      fill={`url(#skin-${seed})`}
      stroke={features.skinPalette.shadow}
      strokeWidth="2"
      filter={`url(#paint-${seed})`}
    />
  );
}

/**
 * Renders cheekbone highlights to add depth and structure to the face.
 * Opacity varies based on the cheekbones feature value.
 *
 * @param props - Component props with render context
 * @returns SVG group element with cheekbone ellipses
 */
export function Cheekbones({ context }: FaceProps) {
  const { features, cx, cy, faceWidth, faceHeight } = context;

  return (
    <>
      {/* Left cheekbone highlight */}
      <ellipse
        cx={cx - faceWidth * 0.25}
        cy={cy + faceHeight * 0.05}
        rx={faceWidth * 0.12}
        ry={faceHeight * 0.06}
        fill={features.skinPalette.highlight}
        opacity={0.3 + features.cheekbones * 0.4}
      />
      {/* Right cheekbone highlight */}
      <ellipse
        cx={cx + faceWidth * 0.25}
        cy={cy + faceHeight * 0.05}
        rx={faceWidth * 0.12}
        ry={faceHeight * 0.06}
        fill={features.skinPalette.highlight}
        opacity={0.3 + features.cheekbones * 0.4}
      />
    </>
  );
}

/**
 * Renders a beard for masculine avatars when enabled.
 * Uses painterly filter for organic appearance.
 *
 * @param props - Component props with render context
 * @returns SVG path element for beard, or null if not applicable
 */
export function Beard({ context }: FaceProps) {
  const { features, seed, cx, cy, faceWidth, faceHeight } = context;

  if (!features.hasBeard) {
    return null;
  }

  return (
    <path
      d={`M ${cx - faceWidth * 0.3} ${cy + faceHeight * 0.15}
          Q ${cx - faceWidth * 0.35} ${cy + faceHeight * 0.4}
            ${cx - faceWidth * 0.15} ${cy + faceHeight * 0.55}
          Q ${cx} ${cy + faceHeight * 0.65}
            ${cx + faceWidth * 0.15} ${cy + faceHeight * 0.55}
          Q ${cx + faceWidth * 0.35} ${cy + faceHeight * 0.4}
            ${cx + faceWidth * 0.3} ${cy + faceHeight * 0.15}`}
      fill={features.hairColor.base}
      opacity="0.85"
      filter={`url(#paint-${seed})`}
    />
  );
}
