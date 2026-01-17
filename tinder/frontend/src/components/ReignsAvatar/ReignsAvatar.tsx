/**
 * @fileoverview ReignsAvatar - Procedural avatar component inspired by Reigns: Her Majesty.
 * Generates deterministic, medieval-portrait-styled avatars from a seed string.
 *
 * @example
 * // Basic usage
 * <ReignsAvatar seed="user-123" />
 *
 * // Custom size
 * <ReignsAvatar seed="user-123" size={200} />
 *
 * // With className
 * <ReignsAvatar seed="user-123" className="rounded-full shadow-lg" />
 */

import { useMemo } from 'react';
import type { AvatarRenderContext } from './types';
import { generateFeatures } from './utils';
import { AvatarDefs } from './AvatarDefs';
import { BackHair, TopHair } from './Hair';
import { Neck, FaceShape, Cheekbones, Beard } from './Face';
import { Eyebrows, Eyes, Nose, Lips } from './FacialFeatures';
import { Crown, Earrings, Necklace } from './Accessories';
import { Clothing, Frame, Background } from './Clothing';

/**
 * Props for the ReignsAvatar component.
 */
export interface ReignsAvatarProps {
  /** Seed string for deterministic avatar generation. Same seed always produces same avatar. */
  seed: string;
  /** Size of the avatar in pixels (default: 400). Avatar is rendered as a square. */
  size?: number;
  /** Additional CSS classes to apply to the SVG element. */
  className?: string;
}

/**
 * Procedural avatar component inspired by Reigns: Her Majesty art style.
 *
 * Generates deterministic, medieval-portrait-styled avatars from a seed string.
 * Used to provide unique profile pictures for users without uploaded photos.
 *
 * Features include:
 * - Customizable face shapes (oval, round, angular, square)
 * - Multiple hair styles (short, medium, long, wavy, braided, bald)
 * - Gender-specific styling (eyelashes, lipstick, accessories)
 * - Royal accessories (crowns, earrings, necklaces)
 * - Painterly texture filter for artistic effect
 *
 * The same seed will always generate the same avatar, making it suitable
 * for consistent user identification across sessions.
 *
 * @param props - ReignsAvatar component props
 * @returns SVG element containing the generated avatar
 *
 * @example
 * // Generate avatar for a user
 * <ReignsAvatar seed={`${user.id}-${user.name}`} size={200} />
 */
export default function ReignsAvatar({
  seed,
  size = 400,
  className = '',
}: ReignsAvatarProps) {
  // Generate features deterministically from seed - memoized to prevent recalculation
  const features = useMemo(() => generateFeatures(seed), [seed]);

  // Calculate positioning values
  const cx = size / 2;
  const cy = size / 2;
  const faceWidth = size * 0.35;
  const faceHeight = size * 0.45;

  // Create render context to pass to all sub-components
  const context: AvatarRenderContext = {
    features,
    seed,
    size,
    cx,
    cy,
    faceWidth,
    faceHeight,
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      style={{ backgroundColor: '#2D2D2D' }}
      role="img"
      aria-label={`Avatar for ${seed}`}
    >
      {/* SVG filter and gradient definitions */}
      <AvatarDefs context={context} />

      {/* Background with radial gradient */}
      <Background context={context} />

      {/* Decorative portrait frame */}
      <Frame context={context} />

      {/* Hair behind face (long, wavy, braided styles) */}
      <BackHair context={context} />

      {/* Neck (rendered before clothing for proper layering) */}
      <Neck context={context} />

      {/* Clothing/Shoulders */}
      <Clothing context={context} />

      {/* Face shape */}
      <FaceShape context={context} />

      {/* Cheekbone highlights */}
      <Cheekbones context={context} />

      {/* Eyebrows */}
      <Eyebrows context={context} />

      {/* Eyes with optional eyelashes */}
      <Eyes context={context} />

      {/* Nose */}
      <Nose context={context} />

      {/* Lips */}
      <Lips context={context} />

      {/* Beard (masculine avatars only) */}
      <Beard context={context} />

      {/* Top/front hair */}
      <TopHair context={context} />

      {/* Crown accessory */}
      <Crown context={context} />

      {/* Earrings (feminine avatars only) */}
      <Earrings context={context} />

      {/* Necklace */}
      <Necklace context={context} />
    </svg>
  );
}
