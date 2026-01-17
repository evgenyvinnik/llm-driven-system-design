/**
 * @fileoverview SVG filter and gradient definitions for the ReignsAvatar.
 * Provides painterly texture effects and color gradients for avatar rendering.
 */

import type { AvatarRenderContext } from './types';

/**
 * Props for the AvatarDefs component.
 */
interface AvatarDefsProps {
  /** Render context containing features and seed */
  context: AvatarRenderContext;
}

/**
 * SVG definitions component containing filters and gradients.
 * Defines reusable effects that are referenced by avatar elements:
 * - Painterly texture filter for artistic brush-stroke effect
 * - Shadow filter for depth
 * - Gradients for skin, hair, clothing, and metallic accessories
 *
 * @param props - Component props with render context
 * @returns SVG defs element with filter and gradient definitions
 */
export function AvatarDefs({ context }: AvatarDefsProps) {
  const { features, seed } = context;

  return (
    <defs>
      {/* Painterly texture filter - creates brush-stroke artistic effect */}
      <filter id={`paint-${seed}`} x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.04"
          numOctaves="3"
          result="noise"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="noise"
          scale="3"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>

      {/* Shadow filter - adds depth to elements like crown */}
      <filter id={`shadow-${seed}`} x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#000" floodOpacity="0.3" />
      </filter>

      {/* Background gradient - subtle color wash behind avatar */}
      <radialGradient id={`bg-${seed}`} cx="50%" cy="40%" r="60%">
        <stop offset="0%" stopColor={features.clothingPalette.primary} stopOpacity="0.3" />
        <stop offset="100%" stopColor="#1a1a1a" />
      </radialGradient>

      {/* Skin gradient - creates realistic skin tone with depth */}
      <linearGradient id={`skin-${seed}`} x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor={features.skinPalette.highlight} />
        <stop offset="50%" stopColor={features.skinPalette.base} />
        <stop offset="100%" stopColor={features.skinPalette.shadow} />
      </linearGradient>

      {/* Hair gradient - adds shine and depth to hair */}
      <linearGradient id={`hair-${seed}`} x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor={features.hairColor.highlight} />
        <stop offset="100%" stopColor={features.hairColor.base} />
      </linearGradient>

      {/* Clothing gradient - rich fabric appearance */}
      <linearGradient id={`cloth-${seed}`} x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor={features.clothingPalette.primary} />
        <stop offset="100%" stopColor={features.clothingPalette.secondary} />
      </linearGradient>

      {/* Metallic sheen gradient - for jewelry and accessories */}
      <linearGradient id={`metal-${seed}`} x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#FFF" stopOpacity="0.6" />
        <stop offset="50%" stopColor={features.accessoryColor} />
        <stop offset="100%" stopColor="#000" stopOpacity="0.3" />
      </linearGradient>
    </defs>
  );
}
